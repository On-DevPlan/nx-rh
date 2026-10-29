// 订阅源（Skill Hub）的登记与列举 —— 与 skills/svc/sources.js 对齐。

use crate::core::paths::CowStrExt;
use std::path::Path;

use serde_json::{json, Value};

use crate::core::errors::{bad_input, not_found, Res};
use crate::core::fstree::path_exists;
use crate::core::paths::absolutize;
use crate::core::store::load_store;
use crate::modules::settings::service as settings;
use super::scan::{read_skill, resolve_skills_root, scan_skills_root};

/// 订阅源清单，附带解析后的 skills 根、是否存在、skill 数、是否当前主源。
pub fn list_sources() -> Res<Value> {
    let s = settings::get_settings();
    let current_raw = s["skillHubPath"].as_str().unwrap_or("");
    let current = if current_raw.is_empty() {
        String::new()
    } else {
        absolutize(Path::new(current_raw)).to_string_lossy().native()
    };
    let hub_dir = load_store()
        .pointer("/remoteRepo/dir")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let sources_raw = crate::core::store::to_array_setting(&s["skillHubSources"]);
    let mut out: Vec<Value> = Vec::new();
    for p in &sources_raw {
        let abs = absolutize(Path::new(p)).to_string_lossy().native();
        let root = resolve_skills_root(Path::new(&abs));
        let skills = scan_skills_root(&root, None, true);
        let is_remote = !hub_dir.is_empty() && abs.eq_ignore_ascii_case(&hub_dir);
        out.push(json!({
            "path": abs,
            "root": root.to_string_lossy().native(),
            "exists": path_exists(Path::new(&abs)),
            "count": skills.len(),
            "current": abs.eq_ignore_ascii_case(&current),
            "remote": if is_remote { json!({ "dir": abs }) } else { Value::Null },
        }));
    }
    // 稳定排序：本地源在前，远程 Hub 恒排最后
    out.sort_by_key(|s| {
        let is_remote = s.get("remote").map(|r| !r.is_null()).unwrap_or(false);
        is_remote as u8
    });
    Ok(json!({ "current": current, "sources": out }))
}

pub fn add_source(path: &str) -> Res<Value> {
    if path.is_empty() {
        return Err(bad_input("path 不能为空"));
    }
    let abs = absolutize(Path::new(path));
    if !path_exists(&abs) {
        return Err(not_found(format!("订阅源目录不存在: {}", abs.display())));
    }
    settings::add_candidate("hub", &abs.to_string_lossy())?; // 新增即设为主源
    list_sources()
}

pub fn remove_source(path: &str) -> Res<Value> {
    settings::remove_candidate("hub", path)?;
    list_sources()
}

pub fn set_source(path: &str) -> Res<Value> {
    settings::set_hub_path(path)?;
    list_sources()
}

/// 当前订阅源（主 Skill Hub）的基本信息：未订阅时返回 { path:'', root:'' }。
pub fn hub_info() -> Value {
    let p = settings::hub_path();
    if p.is_empty() {
        return json!({ "path": "", "root": "", "exists": false, "count": 0 });
    }
    let root = resolve_skills_root(Path::new(&p));
    let count = scan_skills_root(&root, None, true).len();
    json!({
        "path": p,
        "root": root.to_string_lossy().native(),
        "exists": path_exists(Path::new(&p)),
        "count": count
    })
}

/// 当前订阅源的 skill 列表（主源为空时返回空数组，不报错）。
pub fn list_hub_skills() -> Vec<Value> {
    let p = settings::hub_path();
    if p.is_empty() {
        return vec![];
    }
    let root = resolve_skills_root(Path::new(&p));
    scan_skills_root(&root, Some(&p), true)
}

/// 全部订阅源的 skill 池（只认实文件）。主源在前；同名去重留第一份。
pub fn list_all_source_skills() -> Res<Vec<Value>> {
    let listing = list_sources()?;
    let mut sources: Vec<Value> = listing["sources"].as_array().cloned().unwrap_or_default();
    sources.sort_by_key(|s| !(s["current"].as_bool().unwrap_or(false)) as u8);
    let mut by_name: std::collections::BTreeMap<String, Value> = std::collections::BTreeMap::new();
    for s in &sources {
        if !s["exists"].as_bool().unwrap_or(false) {
            continue;
        }
        let root = s["root"].as_str().unwrap_or("");
        let skills = scan_skills_root(Path::new(root), Some(s["path"].as_str().unwrap_or("")), true);
        for sk in skills {
            let name = sk["name"].as_str().unwrap_or_default().to_string();
            by_name.entry(name).or_insert(sk);
        }
    }
    Ok(by_name.into_values().collect())
}

/// 一个 skill 名在**实文件**层面出现在哪些订阅源。
pub fn source_entries_for(name: &str) -> Res<Vec<Value>> {
    let listing = list_sources()?;
    let mut sources: Vec<Value> = listing["sources"].as_array().cloned().unwrap_or_default();
    sources.sort_by_key(|s| !(s["current"].as_bool().unwrap_or(false)) as u8);
    let mut out = Vec::new();
    for s in &sources {
        if !s["exists"].as_bool().unwrap_or(false) {
            continue;
        }
        let dir = Path::new(s["root"].as_str().unwrap_or("")).join(name);
        let Ok(lst) = std::fs::symlink_metadata(&dir) else { continue };
        if lst.is_symlink() || !lst.is_dir() {
            continue;
        }
        if !crate::core::fstree::exists(&dir.join("SKILL.md")) {
            continue;
        }
        if let Some(mut info) = read_skill(&dir) {
            info["source"] = json!(s["path"].as_str().unwrap_or(""));
            out.push(info);
        }
    }
    Ok(out)
}

/// 在全部订阅源里找一个 skill，主源优先；返回首个命中 + alsoIn。
pub fn find_source_skill(name: &str) -> Res<Option<Value>> {
    let entries = source_entries_for(name)?;
    let Some(first) = entries.first() else {
        return Ok(None);
    };
    let mut hit = first.clone();
    if entries.len() > 1 {
        hit["alsoIn"] = json!(entries[1..]
            .iter()
            .map(|e| e["source"].clone())
            .collect::<Vec<_>>());
    }
    Ok(Some(hit))
}

