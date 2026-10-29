// 系统模块：聚合与自检 —— 与 modules/system/index.js 对齐。
// bootstrap 是跨项目唯一的认领签名（app.name）；health 是启动探测的锚点。

pub mod service;
use serde_json::{json, Value};

use crate::core::errors::{bad_input, blocked, not_found, Res};
use crate::core::paths::{cwd_scope, project_root, store_path_from_env, APP_NAME};
use crate::runtime::registry;
use crate::runtime::spec::{compile_route, RouteSeg};
use crate::modules::system::service as svc;

pub const VERSION: &str = crate::VERSION;

/// 命令表：与 help --json 覆盖同一批命令（含平台命令）。
fn command_table() -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for e in registry::builtin_command_entries() {
        out.push(command_entry_json(&e));
    }
    for a in registry::actions() {
        let e = registry::command_entry_of_action(a);
        out.push(command_entry_json(&e));
    }
    out
}

fn command_entry_json(e: &registry::CommandEntry) -> Value {
    json!({
        "id": e.id,
        "module": e.module,
        "command": e.command,
        "usage": e.usage,
        "http": e.http.as_ref().map(|(m, p)| json!({"method": m, "path": p})),
        "summary": e.summary,
    })
}

fn bootstrap(_ctx: &Value, _transport: &str) -> Res<Value> {
    let skills = crate::modules::skills::service();
    Ok(json!({
        "app": { "name": APP_NAME, "version": VERSION },
        "version": VERSION,
        "appStorePath": store_path_from_env().to_string_lossy(),
        "projectRoot": project_root().to_string_lossy(),
        "cwdScope": cwd_scope(None),
        "recents": svc::list_recents(),
        "settings": crate::modules::settings::service::get_settings(),
        "adapters": crate::modules::skills::targets::list_adapters(),
        "hub": skills.hub_info(),
        "sources": skills.list_sources().get("sources").cloned().unwrap_or(json!([])),
        "worktrees": crate::modules::worktrees::service::overview(),
        "commands": command_table(),
    }))
}

fn health(_ctx: &Value, _transport: &str) -> Res<Value> {
    let store_path = store_path_from_env();
    // 存储不可达 / cwd 不可达时给明确错误码，不假装健康
    match std::fs::metadata(&store_path) {
        Ok(md) if md.is_file() => {}
        Ok(_) => return Err(blocked(format!("存储路径不是文件: {}", store_path.display()))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {} // 不存在 = 空 store，可达
        Err(e) => {
            return Err(blocked(format!(
                "存储或工作目录不可达: {}（{}）",
                store_path.display(),
                e
            )))
        }
    }
    std::fs::metadata(project_root())
        .map_err(|e| blocked(format!("存储或工作目录不可达: {}（{}）", store_path.display(), e)))?;
    let s = crate::modules::settings::service::get_settings();
    Ok(json!({
        "status": "ok",
        "version": VERSION,
        "appStorePath": store_path.to_string_lossy(),
        "cwdScope": cwd_scope(None),
        "projectRoot": project_root().to_string_lossy(),
        "storeReadable": s.is_object(),
    }))
}

fn parse_http_query(input: &str) -> Res<(Option<String>, String)> {
    let s = input.trim();
    let (method, path) = match s.split_once(' ') {
        Some((m, p)) => (Some(m.to_uppercase()), p.to_string()),
        None => (None, s.to_string()),
    };
    let path = path.split('?').next().unwrap_or("").to_string();
    if !path.starts_with('/') {
        return Err(bad_input(format!(
            "HTTP 查询需形如 \"/api/repos\" 或 \"POST /api/repos\"，收到: {}",
            input
        )));
    }
    Ok((method, path))
}

fn lookup_by_http(input: &str) -> Res<Value> {
    let (method, path) = parse_http_query(input)?;
    let path_segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let mut hits: Vec<Value> = Vec::new();
    for e in command_table() {
        let Some(http) = e.get("http") else { continue };
        if let Some(m) = method.as_ref() {
            if m != http.get("method").and_then(|x| x.as_str()).unwrap_or("") {
                continue;
            }
        }
        let Some(pattern) = http.get("path").and_then(|p| p.as_str()) else {
            continue;
        };
        let compiled = compile_route(pattern);
        let segs: Vec<RouteSeg> = compiled.segments;
        let matched = segs.len() == path_segs.len()
            && segs.iter().zip(path_segs.iter()).all(|(seg, p)| match seg {
                RouteSeg::Literal(l) => l == *p,
                RouteSeg::Param(_) => true,
            });
        if matched {
            hits.push(e);
        }
    }
    if hits.is_empty() {
        return Err(not_found(format!(
            "没有路由匹配: {}（用 nx-rh-rs routes 查看全部对照）",
            input
        )));
    }
    Ok(Value::Array(hits))
}

fn routes_action(ctx: &Value, _transport: &str) -> Res<Value> {
    // 反向：手里有端点，查该敲哪条命令
    if let Some(http_q) = ctx.get("http").and_then(|h| h.as_str()).filter(|s| !s.is_empty()) {
        return lookup_by_http(http_q);
    }
    let table = command_table();
    match ctx.get("module").and_then(|m| m.as_str()).filter(|s| !s.is_empty()) {
        None => Ok(Value::Array(table)),
        Some(module) => {
            let known: Vec<String> = table
                .iter()
                .filter_map(|c| c.get("module").and_then(|m| m.as_str()).map(|s| s.to_string()))
                .collect();
            if !known.iter().any(|k| k == module) {
                return Err(bad_input(format!(
                    "未知模块: {}（可用: {}）",
                    module,
                    known.join(", ")
                )));
            }
            Ok(Value::Array(
                table
                    .into_iter()
                    .filter(|c| c.get("module").and_then(|m| m.as_str()) == Some(module))
                    .collect(),
            ))
        }
    }
}

fn routes_render(list: &Value, _ctx: &Value) -> String {
    let Some(arr) = list.as_array() else {
        return "（无匹配）".into();
    };
    if arr.is_empty() {
        return "（无匹配）".into();
    }
    let w = arr
        .iter()
        .map(|c| c.get("command").and_then(|c| c.as_str()).map(|s| s.len()).unwrap_or(0))
        .max()
        .unwrap_or(0);
    arr.iter()
        .map(|c| {
            let command = c.get("command").and_then(|c| c.as_str()).unwrap_or("");
            let route = match c.get("http") {
                Some(h) if !h.is_null() => format!(
                    "{} {}",
                    h.get("method").and_then(|m| m.as_str()).unwrap_or(""),
                    h.get("path").and_then(|p| p.as_str()).unwrap_or("")
                ),
                _ => "（仅 CLI，无 HTTP 路由）".to_string(),
            };
            format!("{:<w$}  {}", command, route, w = w + 2)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

// ---- actions ----

macro_rules! arg {
    ($name:expr) => {
        crate::runtime::spec::ArgSpec { name: $name, required: true, rest: false }
    };
    ($name:expr, optional) => {
        crate::runtime::spec::ArgSpec { name: $name, required: false, rest: false }
    };
    ($name:expr, rest) => {
        crate::runtime::spec::ArgSpec { name: $name, required: true, rest: true }
    };
    ($name:expr, rest_optional) => {
        crate::runtime::spec::ArgSpec { name: $name, required: false, rest: true }
    };
}

macro_rules! flag {
    ($name:expr, string) => {
        crate::runtime::spec::FlagSpec {
            name: $name, kind: "string", required: false, default: None, enum_values: None, hint: "",
        }
    };
    ($name:expr, boolean) => {
        crate::runtime::spec::FlagSpec {
            name: $name, kind: "boolean", required: false, default: None, enum_values: None, hint: "",
        }
    };
}

use once_cell::sync::Lazy;

/// action 表（Lazy：Action 里含 Vec 字段，放不进 static 数组）。
pub fn actions() -> &'static Vec<crate::runtime::spec::Action> {
    static ACTIONS: Lazy<Vec<crate::runtime::spec::Action>> = Lazy::new(|| vec![
    crate::runtime::spec::Action {
        id: "system.bootstrap",
        cli: vec![vec!["bootstrap"]],
        http: Some(("GET", "/api/bootstrap")),
        summary: "聚合上下文：版本 / 存储路径 / 设置 / 适配器 / 工作树",
        args: vec![],
        flags: vec![],
        module: "system",
        run: bootstrap,
        render: None,
    },
    crate::runtime::spec::Action {
        id: "system.health",
        cli: vec![vec!["health"]],
        http: Some(("GET", "/api/health")),
        summary: "健康检查（进程存活 + 存储可达 + 当前作用域）",
        args: vec![],
        flags: vec![],
        module: "system",
        run: health,
        render: None,
    },
    crate::runtime::spec::Action {
        id: "system.recents",
        cli: vec![vec!["recents"]],
        http: Some(("GET", "/api/recents")),
        summary: "最近项目目录清单（跨作用域，最近在前）",
        args: vec![],
        flags: vec![],
        module: "system",
        run: |_, _| Ok(svc::list_recents()),
        render: Some(|list, _ctx| {
            let arr = list.as_array().cloned().unwrap_or_default();
            if arr.is_empty() {
                return "（暂无最近项目，用 nx-rh-rs recents add <目录> 添加，或在项目目录里启动 serve）".into();
            }
            arr.iter()
                .map(|r| {
                    let path = r.get("path").and_then(|p| p.as_str()).unwrap_or("");
                    let at = r
                        .get("lastUsedAt")
                        .and_then(|a| a.as_str())
                        .unwrap_or("")
                        .get(..19)
                        .unwrap_or("")
                        .replace('T', " ");
                    format!("{}  ({})", path, at)
                })
                .collect::<Vec<_>>()
                .join("\n")
        }),
    },
    crate::runtime::spec::Action {
        id: "system.recents.touch",
        cli: vec![vec!["recents", "add"]],
        http: Some(("POST", "/api/recents")),
        summary: "把一个目录登记为最近项目",
        args: vec![arg!("path", optional)],
        flags: vec![],
        module: "system",
        run: |ctx, _| {
            let path = ctx
                .get("path")
                .and_then(|p| p.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .unwrap_or_else(|| project_root().to_string_lossy().to_string());
            svc::touch_recent(&path)
        },
        render: Some(|list, _ctx| {
            let n = list.as_array().map(|a| a.len()).unwrap_or(0);
            format!("已登记，共 {} 个最近项目", n)
        }),
    },
    crate::runtime::spec::Action {
        id: "system.recents.remove",
        cli: vec![vec!["recents", "remove"]],
        http: Some(("DELETE", "/api/recents")),
        summary: "从最近项目移除（不动磁盘）",
        args: vec![arg!("path")],
        flags: vec![],
        module: "system",
        run: |ctx, _| {
            let path = ctx.get("path").and_then(|p| p.as_str()).unwrap_or("");
            svc::remove_recent(path)
        },
        render: Some(|list, _ctx| {
            let n = list.as_array().map(|a| a.len()).unwrap_or(0);
            format!("已移除，剩余 {} 个", n)
        }),
    },
    crate::runtime::spec::Action {
        id: "system.routes",
        cli: vec![vec!["routes"]],
        http: None,
        summary: "命令 ↔ 路由对照表（--module 过滤；--http 反查命令）",
        args: vec![],
        flags: vec![flag!("module", string), flag!("http", string)],
        module: "system",
        run: routes_action,
        render: Some(routes_render),
    },
    ]);
    &ACTIONS
}
