// 环境变量平台驱动：Windows 注册表里的持久化变量 —— 与 core/envvars.js 对齐。
// PowerShell 一次调用拿回无损 JSON；数据全部走子进程环境块/临时文件，不拼进脚本文本。

use serde_json::json;
use std::process::{Command, Stdio};

use super::errors::{bad_input, blocked, external, AppError, Res};

pub const SCOPES: [&str; 2] = ["user", "system"];
pub const KINDS: [&str; 2] = ["String", "ExpandString"];

pub fn is_supported() -> bool {
    cfg!(windows)
}

/// 与 Node 的 `process.platform` 同名的平台标识。
/// Rust 的 `PLATFORM` 是 "windows"/"linux"/"macos"，
/// 而 JS 版与前端都按 "win32"/"darwin"/"linux" 读——这里给对齐值，
/// 免得 --json 输出与 JS 版对不上。
pub const PLATFORM: &str = if cfg!(windows) {
    "win32"
} else if cfg!(target_os = "macos") {
    "darwin"
} else if cfg!(target_os = "freebsd") {
    "freebsd"
} else if cfg!(target_os = "openbsd") {
    "openbsd"
} else {
    "linux"
};

fn assert_scope(scope: &str) -> Res<()> {
    if !SCOPES.contains(&scope) {
        return Err(bad_input(format!("scope 只能是 user | system，收到: {}", scope)));
    }
    Ok(())
}

const PS_TIMEOUT_MS: u64 = 30000;

fn reg_target(scope: &str) -> (&'static str, &'static str) {
    match scope {
        "system" => (
            "[Microsoft.Win32.Registry]::LocalMachine",
            "SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
        ),
        _ => ("[Microsoft.Win32.Registry]::CurrentUser", "Environment"),
    }
}

struct PsOut {
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

fn run_powershell(script: &str, extra_env: &[(&str, &str)]) -> PsOut {
    let timed_out = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (tx, rx) = std::sync::mpsc::channel();

    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", script]);
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let timed_out2 = timed_out.clone();
    std::thread::spawn(move || {
        let out = cmd
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output();
        let _ = tx.send(out);
    });

    match rx.recv_timeout(std::time::Duration::from_millis(PS_TIMEOUT_MS)) {
        Ok(Ok(out)) => PsOut {
            code: out.status.code(),
            stdout: String::from_utf8_lossy(&out.stdout).to_string(),
            stderr: String::from_utf8_lossy(&out.stderr).to_string(),
        },
        // 起不来的情形（powershell 不在 PATH）也要给一条**与 JS 同形**的文案：
        // Node 的 child_process 在这里说的是 `spawn powershell ENOENT`，
        // 而 std 的 io::Error 只会说 "program not found" —— 两版报错文案就此分叉。
        // 错误文本是 agent 的判断依据（assets 里明确教它读这段），所以要对齐。
        Ok(Err(e)) => PsOut {
            code: Some(-1),
            stdout: String::new(),
            stderr: format!("spawn powershell {}", spawn_errno(&e)),
        },
        Err(_) => {
            timed_out2.store(true, std::sync::atomic::Ordering::Relaxed);
            PsOut {
                code: Some(-1),
                stdout: String::new(),
                stderr: format!("PowerShell 执行超时（>{}s），已终止", PS_TIMEOUT_MS / 1000),
            }
        }
    }
}

/// 把 io::Error 归一到 Node 的 errno 词表，好让报错文案与 JS 版逐字相同。
fn spawn_errno(e: &std::io::Error) -> &'static str {
    match e.kind() {
        std::io::ErrorKind::NotFound => "ENOENT",
        std::io::ErrorKind::PermissionDenied => "EACCES",
        _ => "UNKNOWN",
    }
}

/// stdout 的最后一行是唯一的 JSON 信封；从后往前找第一行能解析的 JSON。
pub fn parse_envelope(stdout: &str) -> Option<serde_json::Value> {
    for line in stdout.lines().rev() {
        let t = line.trim();
        if !t.starts_with('{') {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(t) {
            return Some(v);
        }
    }
    None
}

/// PowerShell 单元素数组退化为裸对象 / 空数组输出空串 → 归一化。
pub fn normalize_items(v: &serde_json::Value) -> Vec<serde_json::Value> {
    let arr: Vec<serde_json::Value> = match v {
        serde_json::Value::Null => vec![],
        Value::Array(a) => a.clone(),
        x => vec![x.clone()],
    };
    arr.into_iter()
        .filter(|x| x.is_object() && x.get("name").and_then(|n| n.as_str()).is_some())
        .map(|x| {
            let kind = x.get("kind").and_then(|k| k.as_str()).unwrap_or("String");
            let kind = if KINDS.contains(&kind) { kind } else { "String" };
            let value = match x.get("value") {
                Some(serde_json::Value::Null) | None => "",
                Some(v) => match v {
                    Value::String(s) => s.as_str(),
                    other => return serde_json::json!({"name": x["name"], "kind": kind, "value": other.to_string()}),
                },
            };
            serde_json::json!({"name": x["name"], "kind": kind, "value": value})
        })
        .collect()
}

use serde_json::Value;

pub fn normalize_read_data(data: &Value) -> Value {
    let mut out = serde_json::Map::new();
    for scope in SCOPES {
        let s = data.get(scope).cloned().unwrap_or(json!({}));
        out.insert(
            scope.to_string(),
            json!({
                "exists": s.get("exists").map(|e| e.as_bool().unwrap_or(true)).unwrap_or(true),
                "values": normalize_items(s.get("values").unwrap_or(&Value::Null))
            }),
        );
    }
    Value::Object(out)
}

/// 错误分类：异常类型名 → 既有码（错误分类不看本地化文案）。
pub fn classify_driver_error(type_name: &str, detail: &str) -> AppError {
    match type_name {
        "UnauthorizedAccessException" | "SecurityException" => blocked(
            "需要管理员权限：写系统级环境变量要求 nx-rh-rs 以管理员身份运行（用户级不受影响，用 --scope user 即可）",
        ),
        "ItemNotFoundException" | "NullReferenceException" => {
            blocked(format!("注册表键不存在或不可访问：{}", detail))
        }
        t => external(format!(
            "注册表操作失败{}{}",
            if t.is_empty() { String::new() } else { format!("（{}）", t) },
            if detail.is_empty() { String::new() } else { format!(": {}", detail) }
        )),
    }
}

fn posix_driver() -> AppError {
    blocked(format!(
        "环境变量模块目前只支持 Windows（当前平台: {}）。macOS 的 launchctl 与 Linux 的 shell rc 语义差异很大，留待后续单独实现，以免做出「看似支持实则不生效」的假实现。",
        PLATFORM
    ))
}

const JSON_ENVELOPE: &str = "ConvertTo-Json -InputObject (%EXPR%) -Compress -Depth 6";

const CATCH_BLOCK: &str = "
} catch {
  $e = $_.Exception
  while ($e.InnerException -ne $null) { $e = $e.InnerException }
  ConvertTo-Json -InputObject ([pscustomobject]@{ ok=$false; type=$e.GetType().Name; message=[string]$e.Message }) -Compress -Depth 6
}";

fn probe_script() -> String {
    let s = "
$ErrorActionPreference='Stop'
try {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p = New-Object Security.Principal.WindowsPrincipal($id)
  ConvertTo-Json -InputObject ([pscustomobject]@{ ok=$true; elevated=$p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator); user=$id.Name }) -Compress -Depth 6
{CATCH}
";
    s.replace("{CATCH}", CATCH_BLOCK)
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeInfo {
    pub supported: bool,
    pub elevated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    pub writable: Writable,
    #[serde(skip_serializing_if = "Option::is_none")]
    // probe 的失败原因：JS 版同样会算出来，但 status() 不转发（见 modules/env/service.rs）。
    // 保留这个字段是为了让「探测失败」在日志/排障里有话说，不是无用数据。
    #[allow(dead_code)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Writable {
    pub user: bool,
    pub system: bool,
}

pub fn probe() -> ProbeInfo {
    if !is_supported() {
        return ProbeInfo {
            supported: false,
            elevated: false,
            user: None,
            writable: Writable { user: false, system: false },
            reason: None,
        };
    }
    let r = run_powershell(&probe_script(), &[]);
    let env = parse_envelope(&r.stdout);
    match env {
        Some(e) if e.get("ok").and_then(|o| o.as_bool()).unwrap_or(false) => ProbeInfo {
            supported: true,
            elevated: e.get("elevated").and_then(|v| v.as_bool()).unwrap_or(false),
            user: e.get("user").and_then(|v| v.as_str()).map(|s| s.to_string()),
            writable: Writable {
                user: true,
                system: e.get("elevated").and_then(|v| v.as_bool()).unwrap_or(false),
            },
            reason: None,
        },
        Some(e) => {
            let msg = classify_driver_error(
                e.get("type").and_then(|t| t.as_str()).unwrap_or(""),
                "",
            )
            .message;
            ProbeInfo {
                supported: false,
                elevated: false,
                user: None,
                writable: Writable { user: false, system: false },
                reason: Some(msg),
            }
        }
        None => ProbeInfo {
            supported: false,
            elevated: false,
            user: None,
            writable: Writable { user: false, system: false },
            reason: Some("PowerShell 不可用或调用失败".into()),
        },
    }
}

fn read_script() -> String {
    let s = "
$ErrorActionPreference='Stop'
function Read-NxRhScope([Microsoft.Win32.RegistryKey]$root, [string]$sub) {
  $k = $root.OpenSubKey($sub, $false)
  if ($k -eq $null) { return [pscustomobject]@{ exists=$false; values=@() } }
  $items = @()
  foreach ($n in $k.GetValueNames()) {
    $raw = $k.GetValue($n, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $val = [string]$raw
    if ($raw -is [byte[]]) { $val = [Convert]::ToBase64String($raw) }
    $items += [pscustomobject]@{ name=$n; kind=$k.GetValueKind($n).ToString(); value=$val }
  }
  $k.Close()
  return [pscustomobject]@{ exists=$true; values=$items }
}
try {
  $u = Read-NxRhScope ([Microsoft.Win32.Registry]::CurrentUser) 'Environment'
  $s = Read-NxRhScope ([Microsoft.Win32.Registry]::LocalMachine) 'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
  $result = [pscustomobject]@{ user=$u; system=$s }
  ConvertTo-Json -InputObject ([pscustomobject]@{ ok=$true; data=$result }) -Compress -Depth 6
{CATCH}
";
    s.replace("{CATCH}", CATCH_BLOCK)
}

/// 读取：一次调用拿回两个 scope。
pub fn read_all() -> Res<Value> {
    if !is_supported() {
        return Err(posix_driver());
    }
    let r = run_powershell(&read_script(), &[]);
    let env = parse_envelope(&r.stdout).ok_or_else(|| {
        external(format!(
            "PowerShell 未返回可解析的结果：{}",
            if r.stderr.trim().is_empty() {
                format!("退出码 {}", r.code.unwrap_or(-1))
            } else {
                r.stderr.trim().chars().take(200).collect()
            }
        ))
    })?;
    if !env.get("ok").and_then(|o| o.as_bool()).unwrap_or(false) {
        return Err(classify_driver_error(
            env.get("type").and_then(|t| t.as_str()).unwrap_or(""),
            env.get("message").and_then(|m| m.as_str()).unwrap_or(""),
        ));
    }
    let empty = json!({});
    Ok(normalize_read_data(env.get("data").unwrap_or(&empty)))
}

const NOTIFY_BLOCK: &str = "
$notified = $false
try {
  Add-Type -Namespace NxRhRs -Name Native -MemberDefinition '[DllImport(\"user32.dll\", CharSet=CharSet.Auto, SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);'
  $hr = [IntPtr]::Zero
  $null = [NxRhRs.Native]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [IntPtr]::Zero, 'Environment', 2, 5000, [ref]$hr)
  $notified = $true
} catch { }
";

fn write_script(scope: &str, notify: bool) -> String {
    let (root, sub) = reg_target(scope);
    let notify_block = if notify { NOTIFY_BLOCK } else { "$notified = $false" };
    format!(
        "
$ErrorActionPreference='Stop'
try {{
  $k = {root}.OpenSubKey('{sub}', $true)
  if ($k -eq $null) {{ throw (New-Object System.Management.Automation.ItemNotFoundException('key')) }}
  $enc = New-Object System.Text.UTF8Encoding($false)
  $v = [IO.File]::ReadAllText($env:NX_RH_VALUE_FILE, $enc)
  $kind = [Microsoft.Win32.RegistryValueKind]$env:NX_RH_KIND
  $k.SetValue($env:NX_RH_NAME, $v, $kind)
  $k.Close()
  {notify_block}
  {envelope}
{catch}
",
        root = root,
        sub = sub,
        notify_block = notify_block,
        envelope = JSON_ENVELOPE.replace("%EXPR%", "[pscustomobject]@{ ok=$true; notified=$notified }"),
        catch = CATCH_BLOCK,
    )
}

fn delete_script(scope: &str, notify: bool) -> String {
    let (root, sub) = reg_target(scope);
    let notify_block = if notify { NOTIFY_BLOCK } else { "$notified = $false" };
    format!(
        "
$ErrorActionPreference='Stop'
try {{
  $k = {root}.OpenSubKey('{sub}', $true)
  if ($k -eq $null) {{ throw (New-Object System.Management.Automation.ItemNotFoundException('key')) }}
  $k.DeleteValue($env:NX_RH_NAME, $true)
  $k.Close()
  {notify_block}
  {envelope}
{catch}
",
        root = root,
        sub = sub,
        notify_block = notify_block,
        envelope = JSON_ENVELOPE.replace("%EXPR%", "[pscustomobject]@{ ok=$true; notified=$notified }"),
        catch = CATCH_BLOCK,
    )
}

/// 值走临时文件：避开环境块上限，值永不进入脚本文本。
fn with_value_file(value: &str, f: impl FnOnce(&str) -> Res<Value>) -> Res<Value> {
    let name = format!(
        "nx-rh-rs-env-{:x}.txt",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    let file = std::env::temp_dir().join(name);
    std::fs::write(&file, value).map_err(super::errors::io_err)?;
    let file_str = file.to_string_lossy().to_string();
    let result = f(&file_str);
    let _ = std::fs::remove_file(&file);
    result
}

fn envelope_result(r: &PsOut) -> Res<Value> {
    let env = parse_envelope(&r.stdout).ok_or_else(|| {
        external(format!(
            "PowerShell 未返回可解析的结果：{}",
            if r.stderr.trim().is_empty() {
                format!("退出码 {}", r.code.unwrap_or(-1))
            } else {
                r.stderr.trim().chars().take(200).collect()
            }
        ))
    })?;
    if !env.get("ok").and_then(|o| o.as_bool()).unwrap_or(false) {
        return Err(classify_driver_error(
            env.get("type").and_then(|t| t.as_str()).unwrap_or(""),
            env.get("message").and_then(|m| m.as_str()).unwrap_or(""),
        ));
    }
    Ok(env)
}

pub fn write_value(scope: &str, name: &str, value: &str, kind: &str, notify: bool) -> Res<Value> {
    if !is_supported() {
        return Err(posix_driver());
    }
    assert_scope(scope)?;
    if name.is_empty() {
        return Err(bad_input("变量名不能为空"));
    }
    if !KINDS.contains(&kind) {
        return Err(bad_input(format!("kind 只能是 String | ExpandString，收到: {}", kind)));
    }
    if value.len() > 32767 {
        return Err(bad_input(format!(
            "值超过注册表字符串上限（32767 字符），实际 {}",
            value.len()
        )));
    }
    with_value_file(value, |file| {
        let r = run_powershell(
            &write_script(scope, notify),
            &[("NX_RH_NAME", name), ("NX_RH_KIND", kind), ("NX_RH_VALUE_FILE", file)],
        );
        let env = envelope_result(&r)?;
        Ok(json!({ "notified": env.get("notified").and_then(|n| n.as_bool()).unwrap_or(false) }))
    })
}

pub fn delete_value(scope: &str, name: &str, notify: bool) -> Res<Value> {
    if !is_supported() {
        return Err(posix_driver());
    }
    assert_scope(scope)?;
    if name.is_empty() {
        return Err(bad_input("变量名不能为空"));
    }
    let r = run_powershell(&delete_script(scope, notify), &[("NX_RH_NAME", name)]);
    let env = envelope_result(&r)?;
    Ok(json!({ "notified": env.get("notified").and_then(|n| n.as_bool()).unwrap_or(false) }))
}

// 保留 JSON_ENVELOPE 常量的使用（CATCH_BLOCK 内嵌 ConvertTo-Json 已替代）；防止未用告警
#[allow(dead_code)]
fn _unused() -> &'static str {
    JSON_ENVELOPE
}
