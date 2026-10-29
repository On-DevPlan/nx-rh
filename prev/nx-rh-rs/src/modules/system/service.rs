// 系统模块 service：跨作用域的「最近项目」列表 —— 与 modules/system/service.js 对齐。

use serde_json::{json, Value};

use crate::core::errors::{bad_input, Res};
use crate::core::paths::{absolutize, cwd_scope};
use crate::core::store::{load_store, mutate_store};

pub const MAX_RECENTS: usize = 20;

pub fn list_recents() -> Value {
    load_store().get("recents").cloned().unwrap_or(json!([]))
}

/// 登记一个「最近项目」。同一 scope 只保留最新一条。
pub fn touch_recent(dir: &str) -> Res<Value> {
    if dir.is_empty() {
        return Err(bad_input("目录不能为空"));
    }
    let abs = absolutize(std::path::Path::new(dir)).to_string_lossy().to_string();
    let scope = cwd_scope(Some(std::path::Path::new(&abs)));
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    mutate_store(|s| {
        if let Some(arr) = s.get_mut("recents").and_then(|r| r.as_array_mut()) {
            arr.retain(|r| r.get("scope").and_then(|x| x.as_str()) != Some(scope.as_str()));
            arr.insert(
                0,
                json!({ "scope": scope, "path": abs, "lastUsedAt": now }),
            );
            arr.truncate(MAX_RECENTS);
            Ok(Value::Array(arr.clone()))
        } else {
            s["recents"] = json!([]);
            Ok(Value::Array(vec![]))
        }
    })
}

/// 移除一条。移出不存在的项不算错误（幂等）。
pub fn remove_recent(dir: &str) -> Res<Value> {
    if dir.is_empty() {
        return Err(bad_input("目录不能为空"));
    }
    let scope = cwd_scope(Some(std::path::Path::new(dir)));
    mutate_store(|s| {
        if let Some(arr) = s.get_mut("recents").and_then(|r| r.as_array_mut()) {
            arr.retain(|r| r.get("scope").and_then(|x| x.as_str()) != Some(scope.as_str()));
            Ok(Value::Array(arr.clone()))
        } else {
            Ok(Value::Array(vec![]))
        }
    })
}
