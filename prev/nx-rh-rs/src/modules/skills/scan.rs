// skill 目录的扫描与读取 —— 与 skills/svc/scan.js 对齐。
// 来源只认**实文件**，目标侧照常识别链接形态。

use crate::core::paths::CowStrExt;
use std::collections::BTreeMap;
use std::path::Path;

use serde_json::{json, Value};

use crate::core::errors::Res;
use crate::core::frontmatter::parse_frontmatter;
use crate::core::fstree::{exists, md5_of, walk_files};
use crate::core::link::detect_link_type;

pub fn read_skill(dir: &Path) -> Option<Value> {
    let md_path = dir.join("SKILL.md");
    let Ok(raw) = std::fs::read_to_string(&md_path) else {
        return None;
    };
    let fm = parse_frontmatter(&raw);
    let name = if fm.name.is_empty() {
        dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
    } else {
        fm.name
    };
    let description = if fm.description.is_empty() { "(无描述)".to_string() } else { fm.description };
    let last_modified = std::fs::metadata(&md_path)
        .and_then(|m| m.modified())
        .ok()
        .map(|t| {
            let dt: chrono::DateTime<chrono::Utc> = t.into();
            dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        })
        .unwrap_or_default();
    Some(json!({
        "name": name,
        "description": description,
        "dir": dir.to_string_lossy().native(),
        "md5": md5_of(raw.as_bytes()),
        "lastModified": last_modified,
        "linkType": detect_link_type(dir),
    }))
}

/// 目录（或其清单声明）里是否**存在** skill —— 用于根探测。
fn count_skill_dirs(root: &Path) -> usize {
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return 0,
    };
    let mut n = 0;
    let mut names: Vec<String> = Vec::new();
    for e in entries.flatten() {
        names.push(e.file_name().to_string_lossy().to_string());
    }
    names.sort();
    for name in names {
        if name.starts_with('.') {
            continue;
        }
        let child = root.join(&name);
        // 来源只认实文件：链接不算
        let Ok(lst) = std::fs::symlink_metadata(&child) else { continue };
        if lst.is_symlink() || !lst.is_dir() {
            continue;
        }
        if exists(&child.join("SKILL.md")) {
            n += 1;
        }
    }
    if n > 0 {
        return n;
    }
    collect_container_skills(root, 3).len()
}

fn collect_container_skills(root: &Path, max_depth: usize) -> Vec<std::path::PathBuf> {
    let mut found = Vec::new();
    walk_container_collect(root, max_depth, &mut found);
    found
}

fn walk_container_collect(dir: &Path, left: usize, found: &mut Vec<std::path::PathBuf>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let mut names: Vec<String> = entries
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    names.sort();
    for name in names {
        if name.starts_with('.') {
            continue;
        }
        let child = dir.join(&name);
        let Ok(lst) = std::fs::symlink_metadata(&child) else { continue };
        if lst.is_symlink() || !lst.is_dir() {
            continue;
        }
        if exists(&child.join("SKILL.md")) {
            found.push(child);
            continue;
        }
        if left <= 1 {
            continue;
        }
        walk_container_collect(&child, left - 1, found);
    }
}

/// 订阅源根目录的探测：直接是 skill / 包一层 skills/ / 类目层级。
pub fn resolve_skills_root(source_path: &Path) -> std::path::PathBuf {
    if count_skill_dirs(source_path) > 0 {
        return source_path.to_path_buf();
    }
    let nested = source_path.join("skills");
    if count_skill_dirs(&nested) > 0 {
        return nested;
    }
    if !collect_container_skills(&nested, 1).is_empty() {
        return nested;
    }
    source_path.to_path_buf()
}

/// 扫描一个 skills 根目录。realOnly=true（来源侧）只认实文件 + 递归容器发现。
pub fn scan_skills_root(root: &Path, source: Option<&str>, real_only: bool) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return out,
    };
    let mut names: Vec<String> = entries
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    names.sort();

    for name in names {
        if name.starts_with('.') {
            continue;
        }
        let dir = root.join(&name);
        let Ok(lst) = std::fs::symlink_metadata(&dir) else { continue };
        if !lst.is_dir() && !lst.is_symlink() {
            continue;
        }
        match read_skill(&dir) {
            Some(mut info) => {
                if real_only && !info["linkType"].as_str().unwrap_or("").is_empty() {
                    seen.insert(name);
                    continue; // 是 skill 但是链接 → 来源侧跳过
                }
                if let Some(src) = source {
                    info["source"] = json!(src);
                }
                seen.insert(name);
                out.push(info);
            }
            None => {
                if real_only {
                    // 来源侧：一级不是 skill 就按容器目录向下走（浅层遮蔽，最多 3 层）
                    walk_container_push(&dir, 3, source, &mut out, &mut seen);
                    continue;
                }
                // 目标侧：链接目标缺失的占位行
                let lt = if lst.is_symlink() {
                    "symlink".to_string()
                } else {
                    detect_link_type(&dir)
                };
                if !lt.is_empty() {
                    out.push(json!({
                        "name": name,
                        "description": "(链接目标缺失，可清理)",
                        "dir": dir.to_string_lossy().native(),
                        "md5": "",
                        "lastModified": "",
                        "linkType": lt,
                        "source": source.map(|s| json!(s)).unwrap_or(Value::Null),
                    }));
                }
            }
        }
    }

    // plugin 清单声明的路径（不受 3 层限制）
    if real_only {
        for found in discover_manifest_skill_dirs(root) {
            let rel = found
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            if seen.contains(&rel) {
                continue;
            }
            if let Some(mut info) = read_skill(&found) {
                if let Some(src) = source {
                    info["source"] = json!(src);
                }
                seen.insert(rel);
                out.push(info);
            }
        }
    }
    out
}

fn walk_container_push(
    dir: &Path,
    max_depth: usize,
    source: Option<&str>,
    out: &mut Vec<Value>,
    seen: &mut std::collections::HashSet<String>,
) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let mut names: Vec<String> = entries
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    names.sort();
    for name in names {
        if name.starts_with('.') || seen.contains(&name) {
            continue;
        }
        let child = dir.join(&name);
        let Ok(lst) = std::fs::symlink_metadata(&child) else { continue };
        if lst.is_symlink() || !lst.is_dir() {
            continue;
        }
        if let Some(mut info) = read_skill(&child) {
            if !info["linkType"].as_str().unwrap_or("").is_empty() {
                continue; // 链接不算来源
            }
            if let Some(src) = source {
                info["source"] = json!(src);
            }
            seen.insert(name);
            out.push(info);
            continue;
        }
        if max_depth <= 1 {
            continue;
        }
        walk_container_push(&child, max_depth - 1, source, out, seen);
    }
}

/// .claude-plugin 清单（marketplace.json / plugin.json）声明的 skill 路径。
fn discover_manifest_skill_dirs(root: &Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    let read_json = |p: &Path| -> Option<Value> {
        std::fs::read_to_string(p).ok().and_then(|s| serde_json::from_str(&s).ok())
    };

    let add_dir = |base: &str, rel: &str, out: &mut Vec<std::path::PathBuf>| {
        if rel.is_empty() {
            return;
        }
        let norm = rel.replace('\\', "/");
        let norm = norm.trim_start_matches("./").trim_start_matches('.').trim_end_matches('/');
        if norm.split('/').any(|s| s == "..") || norm.is_empty() {
            return;
        }
        let dir = root.join(base).join(norm);
        if exists(&dir.join("SKILL.md")) {
            out.push(dir);
        }
    };

    if let Some(mkt) = read_json(&root.join(".claude-plugin").join("marketplace.json")) {
        let plugin_root = mkt
            .pointer("/metadata/pluginRoot")
            .and_then(|v| v.as_str())
            .unwrap_or(".");
        if let Some(plugins) = mkt.get("plugins").and_then(|p| p.as_array()) {
            for p in plugins {
                if let Some(skills) = p.get("skills").and_then(|s| s.as_array()) {
                    for s in skills {
                        if let Some(spath) = s.as_str() {
                            add_dir(plugin_root, spath, &mut out);
                        }
                    }
                }
            }
        }
    }
    if let Some(plugin) = read_json(&root.join(".claude-plugin").join("plugin.json")) {
        if let Some(skills) = plugin.get("skills").and_then(|s| s.as_array()) {
            for s in skills {
                if let Some(spath) = s.as_str() {
                    add_dir(".", spath, &mut out);
                }
            }
        }
    }
    out
}

/// 目录内容指纹：排序后的 相对路径\0文件md5 行拼接 → 整体 md5。
pub fn skill_dir_hash(dir: &Path) -> String {
    let files = walk_files(dir);
    let lines: Vec<String> = files
        .iter()
        .map(|(rel, f)| format!("{}\0{}", rel, f.md5))
        .collect();
    md5_of(lines.join("\n").as_bytes())
}

/// 一个 skills 根目录的快照：{ skill名: 目录指纹 }。
#[allow(dead_code)]
pub fn snapshot_skills(dir: &Path) -> Res<Value> {
    let root = resolve_skills_root(dir);
    let skills = scan_skills_root(&root, None, true);
    let mut map = serde_json::Map::new();
    for s in skills {
        let name = s["name"].as_str().unwrap_or_default().to_string();
        let hash = skill_dir_hash(&root.join(&name));
        map.insert(name, json!(hash));
    }
    Ok(Value::Object(map))
}

/// 供 remote 拉取比对：文件表（相对路径 → md5）
#[allow(dead_code)]
pub fn files_of(dir: &Path) -> BTreeMap<String, String> {
    walk_files(dir)
        .into_iter()
        .map(|(k, v)| (k, v.md5))
        .collect()
}
