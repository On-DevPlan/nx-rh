// 设置 service：store.settings 的读写，以及订阅源 / 项目目录候选的维护。
// 定位：**基础模块**。它是唯一允许被其他模块只读依赖的模块。

use serde_json::{json, Value};

use crate::core::errors::{bad_input, Res};
use crate::core::paths::absolutize;
use crate::core::store::{load_store, mutate_store, to_array_setting, ARRAY_SETTINGS};
use crate::core::link::same_path;

pub fn get_settings() -> Value {
    load_store().get("settings").cloned().unwrap_or(json!({}))
}

pub fn update_settings(patch: &Value) -> Res<Value> {
    mutate_store(|s| {
        let patch_obj = patch.as_object().filter(|o| !o.is_empty());
        if let Some(patch_obj) = patch_obj {
            for (k, v) in patch_obj {
                if k == "skillHubPath" {
                    let val = v.as_str().unwrap_or("");
                    if val.is_empty() {
                        s["settings"]["skillHubPath"] = json!("");
                    } else {
                        let p = absolutize(std::path::Path::new(val)).to_string_lossy().to_string();
                        s["settings"]["skillHubPath"] = json!(p);
                        // 设为主源时自动纳入订阅列表
                        let sources = to_array_setting(&s["settings"]["skillHubSources"]);
                        if !sources.iter().any(|c| c.eq_ignore_ascii_case(&p)) {
                            let mut arr = sources;
                            arr.push(p.clone());
                            s["settings"]["skillHubSources"] = json!(arr);
                        }
                    }
                    continue;
                }
                if ARRAY_SETTINGS.contains(&k.as_str()) {
                    s["settings"][k.as_str()] = json!(to_array_setting(v));
                    continue;
                }
                if !v.is_null() {
                    if let Some(str_v) = v.as_str() {
                        s["settings"][k.as_str()] = json!(str_v);
                    } else {
                        s["settings"][k.as_str()] = v.clone();
                    }
                }
            }
        }
        // 不变式回填
        if s["settings"]["skillSyncMode"].as_str() != Some("copy") {
            s["settings"]["skillSyncMode"] = json!("symlink");
        }
        let platforms = to_array_setting(&s["settings"]["platforms"]);
        if platforms.is_empty() {
            s["settings"]["platforms"] = json!(["claude-code"]);
        }
        let platforms = to_array_setting(&s["settings"]["platforms"]);
        let default_platform = s["settings"]["defaultPlatform"].as_str().unwrap_or("").to_string();
        if !platforms.iter().any(|p| *p == default_platform) {
            s["settings"]["defaultPlatform"] =
                json!(platforms.first().cloned().unwrap_or_else(|| "claude-code".into()));
        }
        Ok(s["settings"].clone())
    })
}

// ─── 当前订阅源（主 Skill Hub）──────────────────────────────────────
// 报错文案里的「未设置」是 agent 失败分类的锚点，不得删除。

pub fn hub_path() -> String {
    let s = load_store();
    let p = s
        .pointer("/settings/skillHubPath")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if p.is_empty() {
        String::new()
    } else {
        absolutize(std::path::Path::new(p)).to_string_lossy().to_string()
    }
}

pub fn require_hub_path() -> Res<String> {
    let p = hub_path();
    if p.is_empty() {
        return Err(bad_input(
            "未设置 Skill Hub 订阅源（nx-rh-rs skill hub subscribe <path>）",
        ));
    }
    Ok(p)
}

pub fn set_hub_path(path: &str) -> Res<Value> {
    if path.is_empty() {
        return Err(bad_input("path 不能为空"));
    }
    let abs = absolutize(std::path::Path::new(path)).to_string_lossy().to_string();
    update_settings(&json!({ "skillHubPath": abs }))?;
    Ok(json!({ "skillHubPath": abs }))
}

// ─── 订阅源 / 项目目录候选 ──────────────────────────────────────────

fn candidate_key(kind: &str) -> Res<&'static str> {
    match kind {
        "hub" => Ok("skillHubSources"),
        "project" => Ok("skillProjectCandidates"),
        _ => Err(bad_input(format!("kind 必须是 hub 或 project，收到: {}", kind))),
    }
}

pub fn list_candidates(kind: &str) -> Res<Value> {
    let key = candidate_key(kind)?;
    Ok(load_store()
        .pointer(&format!("/settings/{}", key))
        .cloned()
        .unwrap_or(json!([])))
}

pub fn add_candidate(kind: &str, path: &str) -> Res<Value> {
    let key = candidate_key(kind)?;
    if path.is_empty() {
        return Ok(load_store()
            .pointer(&format!("/settings/{}", key))
            .cloned()
            .unwrap_or(json!([])));
    }
    let abs = absolutize(std::path::Path::new(path)).to_string_lossy().to_string();
    mutate_store(|s| {
        let arr = to_array_setting(&s["settings"][key]);
        if !arr.iter().any(|p| p.eq_ignore_ascii_case(&abs)) {
            let mut next = arr;
            next.push(abs.clone());
            s["settings"][key] = json!(next);
        }
        if kind == "hub" {
            s["settings"]["skillHubPath"] = json!(abs);
        }
        Ok(s["settings"][key].clone())
    })
}

/// 移除候选：仅从列表移除，不动磁盘。移出不存在的路径不算错误（幂等）。
pub fn remove_candidate(kind: &str, path: &str) -> Res<Value> {
    let key = candidate_key(kind)?;
    let abs = absolutize(std::path::Path::new(path)).to_string_lossy().to_string();
    mutate_store(|s| {
        let arr = to_array_setting(&s["settings"][key]);
        let kept: Vec<String> = arr.into_iter().filter(|p| !p.eq_ignore_ascii_case(&abs)).collect();
        s["settings"][key] = json!(kept);
        if kind == "hub" {
            let hub = s["settings"]["skillHubPath"].as_str().unwrap_or("").to_string();
            if !hub.is_empty() && same_path(&hub, &abs) {
                s["settings"]["skillHubPath"] = json!("");
            }
        }
        Ok(s["settings"][key].clone())
    })
}
