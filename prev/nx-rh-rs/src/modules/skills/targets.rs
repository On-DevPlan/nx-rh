// 迁移目标：to × platform → 目标目录列表的归一 —— 与 skills/svc/targets.rs 对齐。

use serde_json::{json, Value};

use crate::core::errors::{bad_input, Res};
use crate::core::paths::project_root;
use crate::core::store::to_array_setting;
use crate::modules::settings::service::get_settings;
use super::adapters::{adapter_by_id, platform_names, target_dir_for, ADAPTERS, SCOPES};
use super::scan::scan_skills_root;

/// 把 to/platform 归一成目标列表 [{platform, platformName, scope, dir}]。
pub fn resolve_targets(to: &str, platform: &str, project: &str) -> Res<Value> {
    let s = get_settings();
    let proj_root = if project.is_empty() {
        project_root().to_string_lossy().to_string()
    } else {
        project.to_string()
    };
    let to_id = if to == "global" { "user" } else { to };
    let scopes: Vec<&str> = if to_id.is_empty() || to_id == "all" {
        SCOPES.to_vec()
    } else {
        if !SCOPES.contains(&to_id) {
            return Err(bad_input(format!(
                "to 只能是 user | global | project | all，收到: {}",
                to
            )));
        }
        vec![to_id]
    };

    let platform_ids: Vec<&'static str> = if !platform.is_empty() && platform != "all" {
        match adapter_by_id(platform) {
            Some(a) => vec![a.id],
            None => {
                return Err(bad_input(format!(
                    "未知平台: {}（可用: {}，或别名 claude / wb）",
                    platform,
                    platform_names().join(" / ")
                )))
            }
        }
    } else {
        let enabled = to_array_setting(&s["platforms"]);
        if enabled.is_empty() {
            vec!["claude-code"]
        } else {
            // 归一成合法 id
            enabled
                .iter()
                .filter_map(|p| super::adapters::normalize_platform_id(p).pipe_ref(Some))
                .filter(|p| !p.is_empty() && p != "all")
                .map(|p| -> &'static str { Box::leak(p.into_boxed_str()) })
                .collect()
        }
    };

    let mut list = Vec::new();
    for sc in &scopes {
        for pid in &platform_ids {
            let Some(a) = adapter_by_id(pid) else {
                return Err(bad_input(format!("未知平台: {}", pid)));
            };
            let Some(dir) = target_dir_for(a.id, sc, &proj_root) else {
                continue;
            };
            list.push(json!({
                "platform": a.id,
                "platformName": a.name,
                "scope": sc,
                "dir": dir,
            }));
        }
    }
    Ok(Value::Array(list))
}

/// 扫描目标目录，返回该目录下的所有 skill（含形态）。
pub fn scan_target_dir(dir: &str, platform: &str, scope: &str) -> Vec<Value> {
    let mut skills = scan_skills_root(Path::new(dir), None, false);
    for s in &mut skills {
        s["platform"] = json!(platform);
        s["scope"] = json!(scope);
    }
    skills
}

use std::path::Path;

/// 适配器基础表（bootstrap 用）：只含 ADAPTERS 表本身的字段。
/// 与 JS 版 listAdapters() 一致：universal 只在为 true 时出现。
pub fn list_adapters() -> Value {
    Value::Array(
        ADAPTERS
            .iter()
            .map(|a| {
                let mut o = serde_json::Map::new();
                o.insert("id".into(), json!(a.id));
                o.insert("name".into(), json!(a.name));
                o.insert("dir".into(), json!(a.dir));
                o.insert("globalDir".into(), json!(a.global_dir));
                if a.universal {
                    o.insert("universal".into(), json!(true));
                }
                Value::Object(o)
            })
            .collect(),
    )
}

/// 适配器总表：带上**解析后的绝对安装位置**。
pub fn adapters_info(project: &str) -> Value {
    let s = get_settings();
    let proj_root = if project.is_empty() {
        project_root().to_string_lossy().to_string()
    } else {
        project.to_string()
    };
    let platforms = to_array_setting(&s["platforms"]);
    let default_platform = s["defaultPlatform"].as_str().unwrap_or("");
    Value::Array(
        ADAPTERS
            .iter()
            .map(|a| {
                json!({
                    "id": a.id,
                    "name": a.name,
                    "dir": a.dir,
                    "globalDir": a.global_dir,
                    "enabled": platforms.iter().any(|p| p == a.id),
                    "isDefault": default_platform == a.id,
                    "userDir": target_dir_for(a.id, "user", "").unwrap_or_default(),
                    "projectDir": target_dir_for(a.id, "project", &proj_root).unwrap_or_default(),
                })
            })
            .collect(),
    )
}

trait PipeRef: Sized {
    fn pipe_ref<T>(self, f: impl FnOnce(Self) -> T) -> T {
        f(self)
    }
}
impl<T> PipeRef for T {}
