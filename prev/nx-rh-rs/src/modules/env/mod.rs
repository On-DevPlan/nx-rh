// 环境变量模块 —— 与 modules/env/index.js 对齐。

pub mod service;

use serde_json::{json, Value};

use crate::core::errors::{bad_input, Res};
use crate::runtime::spec::{Action, ArgSpec, FlagSpec};

// CLI 侧 kind 用短词；注册表侧用真名。
fn kind_in(kind: &str) -> Res<String> {
    match kind.to_lowercase().as_str() {
        "string" => Ok("String".into()),
        "expand" => Ok("ExpandString".into()),
        "" => Ok(String::new()),
        other => Err(bad_input(format!("--kind 只能是 string | expand，收到: {}", other))),
    }
}

fn kind_out(kind: &str) -> &str {
    match kind {
        "ExpandString" => "expand",
        "String" => "string",
        other => other,
    }
}

fn truncate(v: &str, n: usize) -> String {
    if v.chars().count() > n {
        let t: String = v.chars().take(n - 1).collect();
        format!("{}…", t)
    } else {
        v.to_string()
    }
}

// scope flags：读命令不能带 default（否则合并视图永远出不来）
fn opt_scope_flag() -> FlagSpec {
    FlagSpec {
        name: "scope",
        kind: "string",
        required: false,
        default: None,
        enum_values: Some(vec!["user", "system"]),
        hint: "user|system（省略则合并两个 scope）",
    }
}

fn scope_flag() -> FlagSpec {
    FlagSpec {
        name: "scope",
        kind: "string",
        required: false,
        default: Some(json!("user")),
        enum_values: Some(vec!["user", "system"]),
        hint: "user|system",
    }
}

fn dry_flag() -> FlagSpec {
    FlagSpec { name: "dry-run", kind: "boolean", required: false, default: None, enum_values: None, hint: "只显示将要发生的改动，不落盘" }
}

fn notify_flag() -> FlagSpec {
    FlagSpec { name: "no-notify", kind: "boolean", required: false, default: None, enum_values: None, hint: "跳过 WM_SETTINGCHANGE 广播（约省 3 秒）" }
}

fn aarg(name: &'static str) -> ArgSpec {
    ArgSpec { name, required: true, rest: false }
}

fn oarg(name: &'static str) -> ArgSpec {
    ArgSpec { name, required: false, rest: false }
}

fn notify_of(ctx: &Value) -> bool {
    !ctx["no-notify"].as_bool().unwrap_or(false)
}

// ─── 渲染 ─────────────────────────────────────────────────────────────

fn render_status(s: &Value) -> String {
    if !s["supported"].as_bool().unwrap_or(false) {
        return format!(
            "平台: {}\n环境变量模块目前只支持 Windows。{}",
            s["platform"].as_str().unwrap_or(""),
            match s["reason"].as_str().unwrap_or("") {
                "" => String::new(),
                r => format!("\n{}", r),
            }
        );
    }
    let elevated = s["elevated"].as_bool().unwrap_or(false);
    [
        format!("平台:   {}", s["platform"].as_str().unwrap_or("")),
        format!(
            "提权:   {}{}",
            if elevated { "是" } else { "否" },
            if elevated { String::new() } else { " —— 系统级只可读（以管理员身份运行 nx-rh-rs 后可写）".to_string() }
        ),
        format!(
            "用户级: {}",
            if s.pointer("/scopeWritable/user").and_then(|v| v.as_bool()).unwrap_or(false) { "可写" } else { "不可写" }
        ),
        format!(
            "系统级: {}",
            if s.pointer("/scopeWritable/system").and_then(|v| v.as_bool()).unwrap_or(false) { "可写" } else { "只读（需管理员）" }
        ),
        format!("快照:   {}", s["snapshotDir"].as_str().unwrap_or("")),
        String::new(),
        s["note"].as_str().unwrap_or("").to_string(),
    ]
    .join("\n")
}

fn render_merged(merged: &[Value]) -> String {
    if merged.is_empty() {
        return "（没有任何环境变量）".into();
    }
    let w = merged.iter().map(|m| m["name"].as_str().unwrap_or("").len()).max().unwrap_or(0);
    let rows: Vec<String> = merged
        .iter()
        .map(|m| {
            let mark = if m["shadow"].as_bool().unwrap_or(false) {
                " *"
            } else if m["concat"].as_bool().unwrap_or(false) {
                " +"
            } else if m["duplicate"].as_bool().unwrap_or(false) {
                " ="
            } else {
                "  "
            };
            let src = if m["scope"].as_str() == Some("user") { "user" } else { "sys " };
            let v = if !m["user"].is_null() { &m["user"] } else { &m["system"] };
            format!(
                "  {:<w$}  {}{} {:<6} {}",
                m["name"].as_str().unwrap_or(""),
                src,
                mark,
                kind_out(v["kind"].as_str().unwrap_or("")),
                truncate(v["value"].as_str().unwrap_or(""), 64),
                w = w + 2
            )
        })
        .collect();
    [
        format!("用户级 / 系统级变量（共 {} 条）", merged.len()),
        "  标记: * 用户级遮蔽了系统级（两边值不同）".to_string(),
        "        + PATH 为拼接（系统在前、用户在后），不是遮蔽".to_string(),
        "        = 两边都有且值相同".to_string(),
        String::new(),
        rows.join("\n"),
    ]
    .join("\n")
}

fn render_scoped(d: &Value) -> String {
    let values = d["values"].as_array().cloned().unwrap_or_default();
    if values.is_empty() {
        return format!("（{} 级没有任何环境变量）", d["scope"].as_str().unwrap_or(""));
    }
    let w = values.iter().map(|v| v["name"].as_str().unwrap_or("").len()).max().unwrap_or(0);
    values
        .iter()
        .map(|v| {
            format!(
                "  {:<w$}  {:<6} {}",
                v["name"].as_str().unwrap_or(""),
                kind_out(v["kind"].as_str().unwrap_or("")),
                truncate(v["value"].as_str().unwrap_or(""), 64),
                w = w + 2
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn render_list(d: &Value) -> String {
    if let Some(scope) = d["scope"].as_str().filter(|s| !s.is_empty()) {
        let _ = scope;
        return render_scoped(d);
    }
    let merged = d["merged"].as_array().cloned().unwrap_or_default();
    let mut parts = vec![render_merged(&merged)];
    let path = d["path"].as_array().cloned().unwrap_or_default();
    if !path.is_empty() {
        let sys_n = path.iter().filter(|p| p["scope"].as_str() == Some("system")).count();
        let user_n = path.iter().filter(|p| p["scope"].as_str() == Some("user")).count();
        parts.push(String::new());
        parts.push(format!(
            "生效 PATH（系统 {} 条 + 用户 {} 条，按此顺序）:",
            sys_n, user_n
        ));
        for (i, p) in path.iter().enumerate() {
            parts.push(format!(
                "  {:>3}. [{}] {}{}",
                i,
                if p["scope"].as_str() == Some("user") { "user" } else { "sys " },
                p["path"].as_str().unwrap_or(""),
                if p["duplicate"].as_bool().unwrap_or(false) { "   (重复)" } else { "" }
            ));
        }
    }
    parts.join("\n")
}

fn render_get(d: &Value) -> String {
    if let Some(path_entries) = d["pathEntries"].as_array().filter(|a| !a.is_empty()) {
        let scope_label = if !d["user"].is_null() { " （用户级）" } else { " （系统级）" };
        let mut lines = vec![format!("Path{}", scope_label), String::new()];
        lines.push(format!(
            "生效 PATH 由系统级与用户级**拼接**而成，不是覆盖 —— 共 {} 条:",
            path_entries.len()
        ));
        for (i, p) in path_entries.iter().enumerate() {
            lines.push(format!(
                "  {:>3}. [{}] {}{}",
                i,
                if p["scope"].as_str() == Some("user") { "user" } else { "sys " },
                p["path"].as_str().unwrap_or(""),
                if p["duplicate"].as_bool().unwrap_or(false) { "   (重复)" } else { "" }
            ));
        }
        return lines.join("\n");
    }
    let mut lines = vec![d["name"].as_str().unwrap_or("").to_string()];
    if let Some(u) = d["user"].as_object().filter(|_| !d["user"].is_null()) {
        lines.push(format!(
            "  用户级: [{}] {}",
            kind_out(u.get("kind").and_then(|k| k.as_str()).unwrap_or("")),
            u.get("value").and_then(|v| v.as_str()).unwrap_or("")
        ));
    }
    if let Some(s) = d["system"].as_object().filter(|_| !d["system"].is_null()) {
        lines.push(format!(
            "  系统级: [{}] {}",
            kind_out(s.get("kind").and_then(|k| k.as_str()).unwrap_or("")),
            s.get("value").and_then(|v| v.as_str()).unwrap_or("")
        ));
    }
    if d["shadow"].as_bool().unwrap_or(false) {
        lines.push("  ⚠ 用户级遮蔽了系统级 —— 新进程看到的是用户级的值".into());
    }
    lines.join("\n")
}

fn render_path_list(d: &Value) -> String {
    let section = |scope: &str, entries: &[Value]| -> Vec<String> {
        if entries.is_empty() {
            return vec![format!("{} 级 PATH: （空）", scope)];
        }
        let mut lines = vec![format!("{} 级 PATH（{} 条）:", scope, entries.len())];
        for (i, e) in entries.iter().enumerate() {
            lines.push(format!("  {:>3}. {}", i, e.as_str().unwrap_or("")));
        }
        lines
    };
    if let Some(scope) = d["scope"].as_str().filter(|s| !s.is_empty()) {
        let entries = d["entries"].as_array().cloned().unwrap_or_default();
        return section(scope, &entries).join("\n");
    }
    let user = d["user"].as_array().cloned().unwrap_or_default();
    let system = d["system"].as_array().cloned().unwrap_or_default();
    let mut lines = section("用户", &user);
    lines.push(String::new());
    lines.extend(section("系统", &system));
    lines.push(String::new());
    lines.push("生效顺序 = 系统级条目在前，用户级条目在后。".into());
    lines.join("\n")
}

fn render_write(d: &Value) -> String {
    if d["status"].as_str() == Some("skipped") {
        return format!("已跳过：{}", d["reason"].as_str().unwrap_or(""));
    }
    let dry_run = d["dryRun"].as_bool().unwrap_or(false);
    let head = if dry_run {
        format!(
            "[dry-run] {} —— 以下改动**未**落盘",
            d["reason"].as_str().unwrap_or("")
        )
    } else {
        format!(
            "{} —— 已写入（写入前快照: {}）",
            d["reason"].as_str().unwrap_or(""),
            d["snapshot"].as_str().unwrap_or("")
        )
    };
    let mut lines = vec![head, String::new()];
    if !d["changed"].as_bool().unwrap_or(true) && dry_run {
        lines.push("（没有实际变化）".into());
    }
    lines.push(d["diff"].as_str().unwrap_or("").to_string());
    if !dry_run {
        lines.push(String::new());
        lines.push("已广播 WM_SETTINGCHANGE：新开的终端会读到新值；已启动的进程不会。".into());
    }
    lines.join("\n")
}

fn render_snapshot_list(list: &[Value]) -> String {
    if list.is_empty() {
        return "（还没有快照。每次写操作前都会自动生成一份）".into();
    }
    list.iter()
        .map(|s| {
            format!(
                "{}  {}  user:{} sys:{}  {}",
                s["id"].as_str().unwrap_or(""),
                s["createdAt"].as_str().unwrap_or(""),
                s["userCount"],
                s["systemCount"],
                s["reason"].as_str().unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

use once_cell::sync::Lazy;

/// action 表（Lazy：Action 里含 Vec 字段，放不进 static 数组）。
pub fn actions() -> &'static Vec<Action> {
    static ACTIONS: Lazy<Vec<Action>> = Lazy::new(|| vec![
    Action {
        id: "env.status",
        cli: vec![vec!["env", "status"]],
        http: Some(("GET", "/api/env/status")),
        summary: "能力探测：平台 / 驱动 / 是否提权 / 系统级可否写",
        args: vec![],
        flags: vec![],
        module: "env",
        run: |_, _| service::status(),
        render: Some(|d, _ctx| render_status(d)),
    },
    Action {
        id: "env.list",
        cli: vec![vec!["env", "list"]],
        http: Some(("GET", "/api/env")),
        summary: "列出变量（不带 --scope 时合并两scope并标注遮蔽）",
        args: vec![],
        flags: vec![opt_scope_flag()],
        module: "env",
        run: |ctx, _| service::list(ctx["scope"].as_str().unwrap_or("")),
        render: Some(|d, _ctx| render_list(d)),
    },
    Action {
        id: "env.get",
        cli: vec![vec!["env", "get"]],
        http: Some(("GET", "/api/env/:name")),
        summary: "查看单个变量（两个 scope 的值 + 遮蔽判断）",
        args: vec![aarg("name")],
        flags: vec![],
        module: "env",
        run: |ctx, _| service::get(ctx["name"].as_str().unwrap_or("")),
        render: Some(|d, _ctx| render_get(d)),
    },
    Action {
        id: "env.set",
        cli: vec![vec!["env", "set"]],
        http: Some(("PUT", "/api/env/:name")),
        summary: "写入变量（upsert；已存在的变量保留其原始大小写与类型）",
        args: vec![aarg("name"), oarg("value")],
        flags: vec![
            FlagSpec { name: "value", kind: "string", required: false, default: None, enum_values: None, hint: "值（值以 -- 开头时用这个）" },
            scope_flag(),
            FlagSpec { name: "kind", kind: "string", required: false, default: None, enum_values: Some(vec!["string", "expand"]), hint: "string|expand" },
            dry_flag(),
            notify_flag(),
        ],
        module: "env",
        run: |ctx, _| {
            let value = match ctx["value"].as_str().filter(|v| !v.is_empty()) {
                Some(v) => v.to_string(),
                None => {
                    return Err(bad_input(
                        "缺少值：nx-rh-rs env set <name> <value>（或 --value=<value>）",
                    ))
                }
            };
            service::set_variable(
                ctx["name"].as_str().unwrap_or(""),
                &value,
                ctx["scope"].as_str().unwrap_or("user"),
                &kind_in(ctx["kind"].as_str().unwrap_or(""))?,
                ctx["dry-run"].as_bool().unwrap_or(false),
                notify_of(ctx),
            )
        },
        render: Some(|d, _ctx| render_write(d)),
    },
    Action {
        id: "env.remove",
        cli: vec![vec!["env", "remove"]],
        http: Some(("DELETE", "/api/env/:name")),
        summary: "删除变量（不存在时幂等跳过，不算错误）",
        args: vec![aarg("name")],
        flags: vec![scope_flag(), dry_flag(), notify_flag()],
        module: "env",
        run: |ctx, _| {
            service::remove_variable(
                ctx["name"].as_str().unwrap_or(""),
                ctx["scope"].as_str().unwrap_or("user"),
                ctx["dry-run"].as_bool().unwrap_or(false),
                notify_of(ctx),
            )
        },
        render: Some(|d, _ctx| render_write(d)),
    },
    Action {
        id: "env.path.list",
        cli: vec![vec!["env", "path", "list"]],
        http: Some(("GET", "/api/env/path")),
        summary: "按条目列出 PATH（不手拼字符串）",
        args: vec![],
        flags: vec![opt_scope_flag()],
        module: "env",
        run: |ctx, _| service::path_list(ctx["scope"].as_str().unwrap_or("")),
        render: Some(|d, _ctx| render_path_list(d)),
    },
    Action {
        id: "env.path.add",
        cli: vec![vec!["env", "path", "add"]],
        http: Some(("POST", "/api/env/path")),
        summary: "把一个目录加进 PATH（默认追加在末尾，--first 前置）",
        args: vec![aarg("dir")],
        flags: vec![
            scope_flag(),
            FlagSpec { name: "first", kind: "boolean", required: false, default: None, enum_values: None, hint: "前置而不是追加（会遮蔽系统同名工具，慎用）" },
            dry_flag(),
            notify_flag(),
        ],
        module: "env",
        run: |ctx, _| {
            service::path_add(
                ctx["dir"].as_str().unwrap_or(""),
                ctx["scope"].as_str().unwrap_or("user"),
                if ctx["first"].as_bool().unwrap_or(false) { "first" } else { "last" },
                ctx["dry-run"].as_bool().unwrap_or(false),
                notify_of(ctx),
            )
        },
        render: Some(|d, _ctx| render_write(d)),
    },
    Action {
        id: "env.path.remove",
        cli: vec![vec!["env", "path", "remove"]],
        http: Some(("DELETE", "/api/env/path")),
        summary: "从 PATH 移除一个目录（不存在时幂等跳过；不会让 PATH 变空）",
        args: vec![aarg("dir")],
        flags: vec![scope_flag(), dry_flag(), notify_flag()],
        module: "env",
        run: |ctx, _| {
            service::path_remove(
                ctx["dir"].as_str().unwrap_or(""),
                ctx["scope"].as_str().unwrap_or("user"),
                ctx["dry-run"].as_bool().unwrap_or(false),
                notify_of(ctx),
            )
        },
        render: Some(|d, _ctx| render_write(d)),
    },
    Action {
        id: "env.snapshot.list",
        cli: vec![vec!["env", "snapshot", "list"]],
        http: Some(("GET", "/api/env/snapshots")),
        summary: "列出快照（每次写操作前自动生成）",
        args: vec![],
        flags: vec![],
        module: "env",
        run: |_, _| Ok(json!(service::list_snapshots())),
        render: Some(|d, _ctx| {
            render_snapshot_list(d.as_array().cloned().unwrap_or_default().as_slice())
        }),
    },
    Action {
        id: "env.snapshot.save",
        cli: vec![vec!["env", "snapshot", "save"]],
        http: Some(("POST", "/api/env/snapshots")),
        summary: "手动存一份快照（比如准备在别处改注册表之前）",
        args: vec![oarg("label")],
        flags: vec![],
        module: "env",
        run: |ctx, _| service::save_snapshot(ctx["label"].as_str().unwrap_or("")),
        render: Some(|s, _ctx| {
            format!(
                "已保存快照: {}\n  user {} 条 / system {} 条",
                s["id"].as_str().unwrap_or(""),
                s.pointer("/user/values").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0),
                s.pointer("/system/values").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0)
            )
        }),
    },
    Action {
        id: "env.snapshot.restore",
        cli: vec![vec!["env", "snapshot", "restore"]],
        http: Some(("POST", "/api/env/snapshots/:id/restore")),
        summary: "恢复快照（恢复前会自动再存一份，所以恢复本身可被恢复）",
        args: vec![aarg("id")],
        flags: vec![dry_flag(), notify_flag()],
        module: "env",
        run: |ctx, _| {
            service::restore_snapshot(
                ctx["id"].as_str().unwrap_or(""),
                ctx["dry-run"].as_bool().unwrap_or(false),
                notify_of(ctx),
            )
        },
        render: Some(|d, _ctx| {
            let dry_run = d["dryRun"].as_bool().unwrap_or(false);
            let head = if dry_run {
                format!("[dry-run] 恢复快照 {} —— 以下改动**未**落盘", d["id"].as_str().unwrap_or(""))
            } else {
                format!(
                    "恢复快照 {} 完成（恢复前快照: {}）",
                    d["id"].as_str().unwrap_or(""),
                    d["snapshot"].as_str().unwrap_or("")
                )
            };
            let mut lines = vec![head];
            let skipped: Vec<String> = d["skippedScopes"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect();
            if !skipped.is_empty() {
                lines.push(String::new());
                lines.push(format!(
                    "⚠ 未恢复的 scope: {} —— 系统级恢复需要以管理员身份运行 nx-rh-rs，用户级已恢复。",
                    skipped.join(", ")
                ));
            }
            lines.push(String::new());
            lines.push(d["diff"].as_str().unwrap_or("").to_string());
            lines.join("\n")
        }),
    },
    ]);
    &ACTIONS
}
