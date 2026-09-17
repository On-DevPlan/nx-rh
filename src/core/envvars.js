// 环境变量平台驱动：Windows 注册表里的**持久化**变量（用户级 HKCU\Environment、
// 系统级 HKLM\...\Session Manager\Environment）。改动会影响整台机器 / 当前用户，
// 因此本层只负责「怎么无损地读、怎么类型保真地写」，不做任何业务判断——
// 快照、dry-run、遮蔽分析都在 modules/env/service.js。
//
// ─── 为什么是 PowerShell 而不是 reg.exe ────────────────────────────────
//
// 两条路都在真实机器上对照实测过。reg.exe 被否决有三个理由（每条都带实测数据，
// 因为这三条反直觉、且都会在特定机器上才暴露）：
//
// 1. **输出是控制台代码页编码。** 同一份 `reg query` 输出用 utf-8 解码得到
//    `D:\????\????Ŀ¼`，用 gbk 才得到 `D:\工具\中文目录`。要靠运行时探测
//    代码页再选 TextDecoder 标签，而代码页 → 编码的映射表本身就不完备。
// 2. **它是给人看的表格文本，要靠正则切分。** 真实环境里存在
//    名为 `IntelliJ IDEA Community Edition` 的变量（名字含空格）、值为空的变量
//    （`IntelliJ IDEA`）、值里含连续空格的路径——文本切分在这些数据上会崩。
// 3. **写回时类型会静默降级。** `reg add` 不带 `/t` 打在已存在的 REG_EXPAND_SZ 值上
//    会把它变成 REG_SZ，于是 PATH 里的 %USERPROFILE% 从此不再展开。
//
// PowerShell 一次调用就能拿回 {名字, 类型, 未展开原值} 的无损 JSON（实测约 300ms）。
// 只探测 `powershell`（Windows PowerShell 5.1，系统常驻）：实测环境未安装 pwsh 7，
// 而 5.1 的 .NET API 完全够用。
//
// ─── 注入防线是结构性的，不是转义 ──────────────────────────────────────
//
// 变量值来自 agent，可以直接包含 `'; Remove-Item -Recurse ...`。所以：
// **脚本文本里只有常量，任何数据都不参与拼接。**
//   - 写值：Node 先写成 UTF-8 临时文件，**文件路径**经 $env: 传入（路径本身也不拼进脚本）
//   - 变量名 / 类型 / scope：同样经 $env: 传入
// 走 $env: 而不是把值直接塞进环境变量，是因为 Windows 整个环境块上限 32767 字符，
// 而 PATH 现实可达数 KB——那会是个**静默**的上限。
//
// ─── 错误分类不看本地化文案 ────────────────────────────────────────────
//
// 中文 Windows 的异常 message 是中文，按文案匹配必然在别的语言上失效。
// 脚本把**异常类型名**作为 JSON 字段输出，Node 据此映射成 core/errors.js 的既有码。
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { blocked, external, badInput } from './errors.js';

export const SCOPES = ['user', 'system'];

// 注册表位置。系统级那个是 .NET 里的长路径，注意反斜杠只在 PS 单引号串里出现。
const REG = {
  user: { root: '[Microsoft.Win32.Registry]::CurrentUser', sub: 'Environment', target: 'User' },
  system: {
    root: '[Microsoft.Win32.Registry]::LocalMachine',
    sub: 'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
    target: 'Machine',
  },
};

// 可写的值类型。REG_EXPAND_SZ（ExpandString）必须原样保留——降级成 String 会让
// 值里的 %VAR% 停止展开，这是本模块最容易静默损坏用户 PATH 的一处。
export const KINDS = ['String', 'ExpandString'];

export function isSupported() {
  return process.platform === 'win32';
}

function assertScope(scope) {
  if (!SCOPES.includes(scope)) {
    throw badInput(`scope 只能是 user | system，收到: ${scope}`);
  }
  return scope;
}

// ─── 调用 PowerShell ───────────────────────────────────────────────────

function runPowerShell(script, extraEnv) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        // 数据全部走子进程环境块，不拼进脚本文本
        env: { ...process.env, ...extraEnv },
      });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String((e && e.message) || e) });
      return;
    }
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => resolve({ code: -1, stdout: '', stderr: String((e && e.message) || e) }));
    child.on('close', (code) =>
      // stdout 被 [Console]::OutputEncoding 强制成 UTF-8，可安全按 utf-8 解。
      // stderr 没有这道保证（可能仍是代码页编码），所以它只用于诊断——
      // 分类一律走我们自己输出的 JSON 里的异常类型名，不解析 stderr。
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
    );
  });
}

// 脚本约定：stdout 的最后一行是唯一的 JSON 信封 {"ok":bool,...}。
// 从后往前找第一行能解析的 JSON，这样脚本里额外的诊断输出不会干扰。
export function parseEnvelope(stdout) {
  const lines = String(stdout || '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t.startsWith('{')) continue;
    try {
      return JSON.parse(t);
    } catch {
      // 该行不是完整 JSON，继续往前找
    }
  }
  return null;
}

// ─── PowerShell 输出的归一化 ───────────────────────────────────────────
//
// 必需，不是防御性编程：PowerShell 5.1 的 ConvertTo-Json 对**单元素数组会退化成
// 裸对象**、对**空数组会输出空字符串**。不归一化就会在「这个键下只有一个变量」
// 或「一个变量都没有」时炸——而这两件事在新装的机器上都是常态。
export function normalizeItems(v) {
  if (v === null || v === undefined || v === '') return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr
    .filter((x) => x && typeof x === 'object' && typeof x.name === 'string')
    .map((x) => ({
      name: x.name,
      kind: KINDS.includes(x.kind) ? x.kind : String(x.kind || 'String'),
      value: x.value === null || x.value === undefined ? '' : String(x.value),
    }));
}

export function normalizeReadData(data) {
  const out = {};
  for (const scope of SCOPES) {
    const s = (data && data[scope]) || {};
    out[scope] = { exists: s.exists !== false, values: normalizeItems(s.values) };
  }
  return out;
}

// ─── 错误分类：异常类型名 → core/errors.js 的既有码 ────────────────────
//
// 刻意不新增错误码：BLOCKED 表达「业务规则主动阻止」（未提权 / 平台不支持），
// INVALID_INPUT 表达参数问题，EXTERNAL 表达外部命令失败。这套映射是**封闭**的，
// 遇到没见过的类型就落到最保守的一档，而不是把原始异常文本透给 agent。
export function classifyDriverError(typeName, detail) {
  const t = String(typeName || '');
  if (t === 'UnauthorizedAccessException' || t === 'SecurityException') {
    return blocked(
      '需要管理员权限：写系统级环境变量要求 nx-rh 以管理员身份运行' +
        '（用户级不受影响，用 --scope user 即可）'
    );
  }
  if (t === 'ItemNotFoundException' || t === 'NullReferenceException') {
    return blocked('注册表键不存在或不可访问：' + (detail || ''));
  }
  return external('注册表操作失败' + (t ? `（${t}）` : '') + (detail ? ': ' + detail : ''));
}

// 非 win32：不假装支持。所有入口都在这里被挡下，报可分类的错而不是崩溃——
// CI 跑在 ubuntu-latest 上，这条路径是被断言的。
function posixDriver() {
  throw blocked(
    `环境变量模块目前只支持 Windows（当前平台: ${process.platform}）。` +
      'macOS 的 launchctl 与 Linux 的 shell rc 语义差异很大，' +
      '留待后续单独实现，以免做出「看似支持实则不生效」的假实现。'
  );
}

// ─── 信封一律由 ConvertTo-Json 生成 ────────────────────────────────────
//
// 踩过的坑：探测脚本最初手写 JSON 拼接，`',"user":"' + $id.Name + '"}'
// —— 而 $id.Name 形如 `MACHINE\user`（域账号还可能是 `DOMAIN\user`），那个反斜杠
// 在 JSON 里没转义，于是 `\u` 之外的 `\x` 成了非法转义、JSON.parse 抛错、
// 整个探测静默变成 supported:false——**在 Windows 上报告「本模块只支持 Windows」**。
// 只要信封里可能有用户数据（用户名、变量名、值、异常 message），就必须让
// ConvertTo-Json 负责转义——它同时处理引号、反斜杠、换行与控制字符。
const jsonEnvelope = (objExpr) =>
  `ConvertTo-Json -InputObject (${objExpr}) -Compress -Depth 6`;

// 异常链取最内层：UnauthorizedAccessException 常被包在 MethodInvocationException 里，
// 只看外层类型会把「未提权」误判成 EXTERNAL。类型名跨语言稳定，message 不稳定。
const CATCH_BLOCK = (fields) => `
} catch {
  $e = $_.Exception
  while ($e.InnerException -ne $null) { $e = $e.InnerException }
  ${jsonEnvelope(`[pscustomobject]@{ ok=$false; type=$e.GetType().Name; message=[string]$e.Message${fields || ''} }`)}
}`;

// ─── 探测能力 ──────────────────────────────────────────────────────────

const PROBE_SCRIPT = `
$ErrorActionPreference='Stop'
try {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p = New-Object Security.Principal.WindowsPrincipal($id)
  ${jsonEnvelope(
    '[pscustomobject]@{ ok=$true; ' +
      'elevated=$p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator); ' +
      'user=$id.Name }'
  )}
${CATCH_BLOCK()}
`;

// 面板开局就要知道「系统级能不能写」，否则用户点了才报错。
// 代价约 300ms，所以**不挂进 /api/bootstrap**——只有真正打开那个 tab 才付。
export async function probe() {
  if (!isSupported()) {
    return { supported: false, elevated: false, writable: { user: false, system: false } };
  }
  const r = await runPowerShell(PROBE_SCRIPT);
  const env = parseEnvelope(r.stdout);
  if (!env || !env.ok) {
    return {
      supported: false,
      elevated: false,
      writable: { user: false, system: false },
      reason: env ? classifyDriverError(env.type).message : 'PowerShell 不可用或调用失败',
    };
  }
  return {
    supported: true,
    elevated: env.elevated === true,
    user: env.user || '',
    // 系统级可写 = 已提权。用户级任何时候都可写（HKCU 属于当前用户）
    writable: { user: true, system: env.elevated === true },
  };
}

// ─── 读取：一次调用拿回两个 scope ──────────────────────────────────────
//
// 分两次调用要 ~600ms，合并成一次 ~300ms，而读是最频繁的操作
// （每次写之前也要读一次算 diff）。

const READ_SCRIPT = `
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
  ${jsonEnvelope('[pscustomobject]@{ ok=$true; data=$result }')}
${CATCH_BLOCK()}
`;

export async function readAll() {
  if (!isSupported()) posixDriver();
  const r = await runPowerShell(READ_SCRIPT);
  const env = parseEnvelope(r.stdout);
  if (!env) {
    throw external('PowerShell 未返回可解析的结果：' + (r.stderr.trim().slice(0, 200) || `退出码 ${r.code}`));
  }
  if (!env.ok) throw classifyDriverError(env.type, env.message);
  return normalizeReadData(env.data);
}

// ─── 广播 WM_SETTINGCHANGE ─────────────────────────────────────────────
//
// 让 Explorer 等顶层窗口重读环境，于是**从开始菜单新开的终端**能立刻拿到新值。
// 不广播的话，改动要等下次登录才被新进程看到——那就成了「面板看起来是坏的」。
//
// 代价实测约 1.8s（Add-Type 编译还要额外 ~2.6s），所以放在写成功之后、
// 包在自己的 try/catch 里：广播失败不影响写已经成功这个事实。
const NOTIFY_BLOCK = `
$notified = $false
try {
  Add-Type -Namespace NxRh -Name Native -MemberDefinition '[DllImport("user32.dll", CharSet=CharSet.Auto, SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);'
  $hr = [IntPtr]::Zero
  $null = [NxRh.Native]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [IntPtr]::Zero, 'Environment', 2, 5000, [ref]$hr)
  $notified = $true
} catch { }
`;

// ─── 写入 ──────────────────────────────────────────────────────────────

function writeScript(scope, notify) {
  const { root, sub } = REG[assertScope(scope)];
  return `
$ErrorActionPreference='Stop'
try {
  $k = ${root}.OpenSubKey('${sub}', $true)
  if ($k -eq $null) { throw (New-Object System.Management.Automation.ItemNotFoundException('key')) }
  $enc = New-Object System.Text.UTF8Encoding($false)
  $v = [IO.File]::ReadAllText($env:NX_RH_VALUE_FILE, $enc)
  # 显式带 kind —— 省略它会把 REG_EXPAND_SZ 静默降级成 REG_SZ
  $kind = [Microsoft.Win32.RegistryValueKind]$env:NX_RH_KIND
  $k.SetValue($env:NX_RH_NAME, $v, $kind)
  $k.Close()
  ${notify ? NOTIFY_BLOCK : '$notified = $false'}
  ${jsonEnvelope('[pscustomobject]@{ ok=$true; notified=$notified }')}
${CATCH_BLOCK()}
`;
}

function deleteScript(scope, notify) {
  const { root, sub } = REG[assertScope(scope)];
  return `
$ErrorActionPreference='Stop'
try {
  $k = ${root}.OpenSubKey('${sub}', $true)
  if ($k -eq $null) { throw (New-Object System.Management.Automation.ItemNotFoundException('key')) }
  $k.DeleteValue($env:NX_RH_NAME, $true)
  $k.Close()
  ${notify ? NOTIFY_BLOCK : '$notified = $false'}
  ${jsonEnvelope('[pscustomobject]@{ ok=$true; notified=$notified }')}
${CATCH_BLOCK()}
`;
}

// 值走临时文件：既避开 Windows 环境块 32767 字符的总上限，也让值永远不进入脚本文本。
// 路径本身经 $env: 传入，所以即使 tmpdir 含引号或非 ASCII 也不会破坏脚本。
async function withValueFile(value, fn) {
  const file = join(tmpdir(), `nx-rh-env-${randomBytes(8).toString('hex')}.txt`);
  await fsp.writeFile(file, String(value), 'utf8'); // Node 默认不写 BOM，与 UTF8Encoding($false) 对齐
  try {
    return await fn(file);
  } finally {
    await fsp.rm(file, { force: true }).catch(() => {});
  }
}

export async function writeValue(scope, name, value, kind, { notify = true } = {}) {
  if (!isSupported()) posixDriver();
  assertScope(scope);
  if (!name) throw badInput('变量名不能为空');
  if (!KINDS.includes(kind)) throw badInput(`kind 只能是 ${KINDS.join(' | ')}，收到: ${kind}`);
  if (String(value).length > 32767) {
    throw badInput(`值超过注册表字符串上限（32767 字符），实际 ${String(value).length}`);
  }
  return withValueFile(value, async (file) => {
    const r = await runPowerShell(writeScript(scope, notify), {
      NX_RH_NAME: String(name),
      NX_RH_KIND: kind,
      NX_RH_VALUE_FILE: file,
    });
    const env = parseEnvelope(r.stdout);
    if (!env) {
      throw external('PowerShell 未返回可解析的结果：' + (r.stderr.trim().slice(0, 200) || `退出码 ${r.code}`));
    }
    if (!env.ok) throw classifyDriverError(env.type, env.message);
    return { notified: env.notified === true };
  });
}

export async function deleteValue(scope, name, { notify = true } = {}) {
  if (!isSupported()) posixDriver();
  assertScope(scope);
  if (!name) throw badInput('变量名不能为空');
  const r = await runPowerShell(deleteScript(scope, notify), { NX_RH_NAME: String(name) });
  const env = parseEnvelope(r.stdout);
  if (!env) {
    throw external('PowerShell 未返回可解析的结果：' + (r.stderr.trim().slice(0, 200) || `退出码 ${r.code}`));
  }
  if (!env.ok) throw classifyDriverError(env.type, env.message);
  return { notified: env.notified === true };
}
