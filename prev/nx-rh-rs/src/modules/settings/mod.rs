// 设置模块 —— 与 modules/settings/index.js 对齐。

pub mod service;

use serde_json::{json, Value};

use crate::core::errors::{bad_input, Res};
use crate::runtime::spec::{Action, ArgSpec, FlagSpec};

const SET_USAGE: &str = "nx-rh-rs setting set <key> <value> 或 nx-rh-rs setting set k1=v1 [k2=v2 ...]";

fn render_settings(d: &Value, _ctx: &Value) -> String {
    let Some(obj) = d.as_object() else {
        return String::new();
    };
    obj.iter()
        .map(|(k, v)| match v {
            Value::Array(arr) => format!(
                "{} = {}",
                k,
                arr.iter()
                    .filter_map(|x| x.as_str())
                    .collect::<Vec<_>>()
                    .join(",")
            ),
            other => format!("{} = {}", k, other),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// CLI 侧两种语法归一：`k1=v1 [k2=v2]` 或 `<key> <value>`。
fn patch_from(ctx: &Value, transport: &str) -> Res<Value> {
    if transport == "http" {
        let mut rest = ctx.clone();
        if let Some(obj) = rest.as_object_mut() {
            obj.remove("pairs");
        }
        return Ok(rest);
    }

    let pairs: Vec<String> = ctx
        .get("pairs")
        .and_then(|p| p.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str())
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default();
    if pairs.is_empty() {
        return Err(bad_input(format!("用法: {} —— 缺少参数", SET_USAGE)));
    }

    // 以「第一个 token 是否含 =」区分两种语法
    if !pairs[0].contains('=') {
        if pairs.len() < 2 {
            return Err(bad_input(format!("用法: {} —— 缺少参数 <value>", SET_USAGE)));
        }
        let mut obj = serde_json::Map::new();
        obj.insert(pairs[0].clone(), json!(pairs[1..].join(" ")));
        return Ok(Value::Object(obj));
    }

    let mut obj = serde_json::Map::new();
    for p in &pairs {
        let Some(eq) = p.find('=') else {
            return Err(bad_input(format!("用法: {} —— 参数格式应为 key=value，收到: {}", SET_USAGE, p)));
        };
        if eq == 0 {
            return Err(bad_input(format!("用法: {} —— 参数格式应为 key=value，收到: {}", SET_USAGE, p)));
        }
        obj.insert(p[..eq].to_string(), json!(p[eq + 1..].to_string()));
    }
    Ok(Value::Object(obj))
}

#[allow(dead_code)]
fn str_flag(name: &'static str) -> FlagSpec {
    FlagSpec { name, kind: "string", required: false, default: None, enum_values: None, hint: "" }
}

use once_cell::sync::Lazy;

/// action 表（Lazy：Action 里含 Vec 字段，放不进 static 数组）。
pub fn actions() -> &'static Vec<Action> {
    static ACTIONS: Lazy<Vec<Action>> = Lazy::new(|| vec![
    Action {
        id: "setting.get",
        cli: vec![vec!["setting", "get"]],
        http: None,
        summary: "读取设置（可跟单个键名）",
        args: vec![ArgSpec { name: "key", required: false, rest: false }],
        flags: vec![],
        module: "settings",
        run: |ctx, _| {
            let s = service::get_settings();
            match ctx.get("key").and_then(|k| k.as_str()).filter(|k| !k.is_empty()) {
                Some(key) => Ok(s.get(key).cloned().unwrap_or(Value::Null)),
                None => Ok(s),
            }
        },
        render: Some(|d, ctx| {
            match ctx.get("key").and_then(|k| k.as_str()).filter(|k| !k.is_empty()) {
                Some(_) => match d {
                    Value::String(s) => s.clone(),
                    Value::Array(arr) => arr
                        .iter()
                        .filter_map(|x| x.as_str())
                        .collect::<Vec<_>>()
                        .join(","),
                    other => other.to_string(),
                },
                None => render_settings(d, ctx),
            }
        }),
    },
    Action {
        id: "setting.set",
        cli: vec![vec!["setting", "set"]],
        http: Some(("POST", "/api/settings")),
        summary: "写入设置，支持一次多个（key=value）",
        args: vec![ArgSpec { name: "pairs", required: false, rest: true }],
        flags: vec![],
        module: "settings",
        run: |ctx, transport| {
            let patch = patch_from(ctx, transport)?;
            service::update_settings(&patch)
        },
        render: Some(render_settings),
    },
    ]);
    &ACTIONS
}
