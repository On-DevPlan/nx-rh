// 内置 skill 包：随包发布的 assets/<name>/（SKILL.md + references/…）的列装与安装。
// 与 modules/bundled/service.js 对齐。assets 通过 include_dir 嵌入二进制。

use crate::core::paths::CowStrExt;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::core::errors::{bad_input, not_found, Res};
use crate::core::frontmatter::parse_frontmatter;
use crate::core::fstree::{diff_trees, exists, path_exists};
use crate::core::paths::{assert_safe_name, home_dir};

pub static ASSETS: include_dir::Dir = include_dir::include_dir!("$CARGO_MANIFEST_DIR/assets");

pub fn assets_dir() -> PathBuf {
    std::env::var("NX_RH_ASSETS")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("assets"))
}

/// 默认安装到 Claude Code 的用户级 skills 目录
pub fn default_skills_dir() -> PathBuf {
    home_dir().join(".claude").join("skills")
}

pub const DEFAULT_SKILL_NAME: &str = "nx-rh";

fn canonical_name(name: &str) -> String {
    match name.trim() {
        "repo-hub" => "nx-rh".into(),
        other => other.to_string(),
    }
}

// ─── assets 树的读取（嵌入优先，NX_RH_ASSETS 目录覆盖）───────────────

/// 包内实际存在的 skill：靠 assets/<x>/SKILL.md 判定（排序）。
fn asset_skill_dirs() -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for d in ASSETS.dirs() {
        let name = d.path().to_string_lossy().to_string();
        if !name.contains('/') && d.get_file("SKILL.md").is_some() {
            names.push(name);
        }
    }
    // 也扫磁盘覆盖目录
    let root = assets_dir();
    if let Ok(entries) = std::fs::read_dir(&root) {
        for e in entries.flatten() {
            if e.path().is_dir() && e.path().join("SKILL.md").exists() {
                let name = e.file_name().to_string_lossy().to_string();
                if !names.contains(&name) {
                    names.push(name);
                }
            }
        }
    }
    names.sort();
    names
}

fn degrade_groups(names: &[String]) -> Value {
    let mut groups = serde_json::Map::new();
    for n in names {
        groups.insert(
            n.clone(),
            json!({ "skills": [n], "summary": "（groups.json 缺失或损坏，按目录扫描兜底）" }),
        );
    }
    Value::Object(groups)
}

/// groups.json 只是「便捷别名表」；schema 错必须显式报错。
pub fn load_groups() -> Res<Value> {
    let raw = ASSETS
        .get_file("groups.json")
        .map(|f| String::from_utf8_lossy(f.contents()).to_string())
        .or_else(|| std::fs::read_to_string(assets_dir().join("groups.json")).ok());

    let Some(raw) = raw else {
        return Ok(json!({ "groups": degrade_groups(&asset_skill_dirs()), "source": "assets-dirs" }));
    };

    let parsed: Value = match serde_json::from_str(&raw) {
        Ok(p) => p,
        Err(_) => {
            eprintln!("[nx-rh-rs] assets/groups.json 不是合法 JSON，已降级为目录扫描");
            return Ok(json!({ "groups": degrade_groups(&asset_skill_dirs()), "source": "assets-dirs" }));
        }
    };

    let g = parsed.get("groups").cloned().unwrap_or(Value::Null);
    if !g.is_object() {
        return Err(bad_input("assets/groups.json 缺少 groups 对象（schema 错）"));
    }
    let mut groups = serde_json::Map::new();
    for (key, val) in g.as_object().unwrap() {
        let valid = {
            let b = key.as_bytes();
            !b.is_empty()
                && b[0].is_ascii_lowercase()
                && b[0].is_ascii_alphanumeric()
                && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'-')
        };
        if !valid {
            return Err(bad_input(format!("assets/groups.json 的 group 名非法: {}", key)));
        }
        let skills = val["skills"].as_array().cloned().unwrap_or_default();
        if skills.is_empty() {
            return Err(bad_input(format!(
                "assets/groups.json 的 group \"{}\" 缺少非空 skills 数组（schema 错）",
                key
            )));
        }
        let mut seen: Vec<String> = Vec::new();
        for s in &skills {
            let name = assert_safe_name(s.as_str().unwrap_or(""), "group 里的 skill 名")?;
            if !seen.contains(&name) {
                seen.push(name);
            }
        }
        groups.insert(
            key.clone(),
            json!({ "skills": seen, "summary": val["summary"].as_str().unwrap_or("") }),
        );
    }
    if groups.is_empty() {
        return Err(bad_input("assets/groups.json 里没有任何 group（schema 错）"));
    }
    Ok(json!({ "groups": groups, "source": "manifest" }))
}

/// 默认 group 名 = 包名。
fn resolve_group(key: &str) -> Res<Value> {
    let k = key.trim();
    if k.is_empty() {
        let available = load_groups()?["groups"]
            .as_object()
            .map(|o| {
                let keys: Vec<&str> = o.keys().map(|s| s.as_str()).collect();
                if keys.is_empty() {
                    "(无)".to_string()
                } else {
                    keys.join(", ")
                }
            })
            .unwrap_or_else(|| "(无)".into());
        return Err(bad_input(format!("--group 需要一个值（可用: {}）", available)));
    }
    if k.starts_with('-') {
        return Err(bad_input(format!("--group 的值不能以 - 开头: {}", k)));
    }
    let groups = load_groups()?["groups"].clone();
    let g = groups.get(k).cloned().unwrap_or(Value::Null);
    if g.is_null() {
        let available = groups
            .as_object()
            .map(|o| {
                let keys: Vec<&str> = o.keys().map(|s| s.as_str()).collect();
                if keys.is_empty() { "(无)".to_string() } else { keys.join(", ") }
            })
            .unwrap_or_else(|| "(无)".into());
        return Err(bad_input(format!("未知 group: {}（可用: {}）", k, available)));
    }
    Ok(g)
}

/// `skill list` 的数据：可装的 skill + 默认装哪个 + 有哪些 group + 数据来源。
pub fn groups_info() -> Res<Value> {
    let loaded = load_groups()?;
    let groups = loaded["groups"].clone();
    let ids: Vec<String> = groups.as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default();
    // JS 版用「自己的包名」当默认组（B04 §默认 install 的约定），而它的包名正好是 nx-rh。
    // Rust 版的包名是 nx-rh-rs —— 不是任何 group 的键，所以不能照抄这条：
    // 这里直接用「默认 install 装的那个 skill」（DEFAULT_SKILL_NAME）当默认组，
    // 语义相同（不加参数 install 装的就是它），且不依赖包里有没有 package.json。
    let def = Some(DEFAULT_SKILL_NAME.to_string());
    let mut summaries = serde_json::Map::new();
    let mut group_skills = serde_json::Map::new();
    for (id, val) in groups.as_object().unwrap() {
        summaries.insert(id.clone(), json!(val["summary"].as_str().unwrap_or("")));
        group_skills.insert(id.clone(), val["skills"].clone());
    }
    Ok(json!({
        "skills": asset_skill_dirs(),
        "defaultGroup": def.filter(|d| !groups.get(d).cloned().unwrap_or(Value::Null).is_null()),
        "groups": ids,
        "summaries": summaries,
        "groupSkills": group_skills,
        "source": loaded["source"]
    }))
}

/// 列出包内自带的所有 skill（含文件数与描述）。
pub fn list_bundled_skills() -> Res<Vec<Value>> {
    let mut out: Vec<Value> = Vec::new();
    for name in asset_skill_dirs() {
        // 嵌入树里的文件计数
        let count_embedded = ASSETS
            .get_dir(&name)
            .map(|d| count_files_recursive(d))
            .unwrap_or(0);
        let disk = assets_dir().join(&name);
        let count = if disk.exists() {
            diff_trees(&disk, &disk.join("__nx_rh_missing__")).len()
        } else {
            count_embedded
        };
        if count == 0 {
            continue;
        }
        let md = ASSETS
            .get_dir(&name)
            .and_then(|d| d.get_file("SKILL.md"))
            .map(|f| String::from_utf8_lossy(f.contents()).to_string())
            .or_else(|| std::fs::read_to_string(disk.join("SKILL.md")).ok())
            .unwrap_or_default();
        let description = if md.is_empty() { String::new() } else { parse_frontmatter(&md).description };
        out.push(json!({
            "name": name,
            "dir": if disk.exists() { disk.to_string_lossy().to_string() } else { format!("<embedded>/{}", name) },
            "files": count,
            "description": description
        }));
    }
    out.sort_by(|a, b| a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or("")));
    Ok(out)
}

fn count_files_recursive(d: &include_dir::Dir) -> usize {
    let files = d.files().count();
    let dirs: usize = d.dirs().map(count_files_recursive).sum();
    files + dirs
}

/// 读 assets 文件（嵌入优先，磁盘覆盖优先）
fn asset_file(skill: &str, rel: &str) -> Option<Vec<u8>> {
    let disk = assets_dir().join(skill).join(rel);
    if let Ok(data) = std::fs::read(&disk) {
        return Some(data);
    }
    ASSETS
        .get_dir(skill)
        .and_then(|d| d.get_file(rel))
        .map(|f| f.contents().to_vec())
}

/// 安装**一个**内置 skill。返回值形状与 JS 版兼容。
fn install_one(name: &str, to: &str, force: bool) -> Res<Value> {
    let name = assert_safe_name(&canonical_name(name), "skill 名称")?;
    if asset_file(&name, "SKILL.md").is_none() {
        let available = asset_skill_dirs().join(", ");
        return Err(not_found(format!(
            "未找到内置 skill: {}（可用: {}）",
            name,
            if available.is_empty() { "(无)".into() } else { available }
        )));
    }
    let target_root = if to.is_empty() {
        default_skills_dir()
    } else {
        PathBuf::from(to)
    };
    let dst = target_root.join(&name);
    let files = diff_trees(&assets_dir().join(&name), &dst);

    if files.is_empty() {
        return Ok(json!({ "status": "ok", "skipped": true, "name": name, "path": dst.to_string_lossy().native(), "files": 0, "group": Value::Null }));
    }
    let exists_dst = path_exists(&dst);
    if exists_dst && !force {
        return Ok(json!({ "status": "conflict", "name": name, "path": dst.to_string_lossy().native(), "files": files, "count": files.len(), "group": Value::Null }));
    }
    if exists_dst {
        crate::core::fstree::rm_force(&dst);
    }
    std::fs::create_dir_all(&target_root).map_err(crate::core::errors::io_err)?;
    copy_asset_tree(&name, "", &dst)?;

    Ok(json!({
        "status": "ok",
        "installed": !exists_dst,
        "replaced": exists_dst,
        "name": name,
        "path": dst.to_string_lossy().native(),
        "files": files.len(),
        "group": Value::Null
    }))
}

/// 递归把嵌入的 assets/<skill>/<rel> 拷到目标目录。
fn copy_asset_tree(skill: &str, rel: &str, dst: &Path) -> Res<()> {
    std::fs::create_dir_all(dst).map_err(crate::core::errors::io_err)?;
    // 嵌入树
    if let Some(dir) = ASSETS.get_dir(skill) {
        copy_embedded_dir(dir, rel, dst);
    }
    // 磁盘覆盖
    let disk_dir = assets_dir().join(skill).join(rel);
    if disk_dir.is_dir() {
        for e in std::fs::read_dir(&disk_dir).map_err(crate::core::errors::io_err)?.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let target = dst.join(&name);
            if e.path().is_dir() {
                copy_asset_tree(skill, &join_rel(rel, &name), &target)?;
            } else {
                std::fs::copy(e.path(), &target).map_err(crate::core::errors::io_err)?;
            }
        }
    }
    Ok(())
}

fn copy_embedded_dir(dir: &include_dir::Dir, rel: &str, dst: &Path) {
    // 顶层目录时枚举其子项；子路径时只拷对应子树
    if rel.is_empty() {
        for f in dir.files() {
            let path = f.path().to_string_lossy().to_string();
            let rel_path = path.strip_prefix(dir.path().to_string_lossy().as_ref()).unwrap_or(&path);
            let target = dst.join(rel_path.trim_start_matches('/'));
            if let Some(parent) = target.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(&target, f.contents());
        }
        return;
    }
    if let Some(sub) = dir.get_dir(rel) {
        for f in sub.files() {
            let path = f.path().to_string_lossy().to_string();
            let prefix = sub.path().to_string_lossy().to_string();
            let rel_path = path.strip_prefix(&prefix).unwrap_or(&path);
            let target = dst.join(rel_path.trim_start_matches('/'));
            if let Some(parent) = target.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(&target, f.contents());
        }
    }
}

fn join_rel(base: &str, name: &str) -> String {
    if base.is_empty() {
        name.to_string()
    } else {
        format!("{}/{}", base, name)
    }
}

/// 安装内置 skill 到目标 skills 目录。group 给定时装该组全部。
pub fn install_bundled_skill(name: &str, group: &str, to: &str, force: bool) -> Res<Value> {
    if !group.trim().is_empty() {
        let g = resolve_group(group)?;
        let mut skills: Vec<Value> = Vec::new();
        for s in g["skills"].as_array().cloned().unwrap_or_default() {
            skills.push(install_one(s.as_str().unwrap_or(""), to, force)?);
        }
        let all_ok = skills.iter().all(|r| r["status"].as_str() == Some("ok"));
        return Ok(json!({
            "status": if all_ok { "ok" } else { "conflict" },
            "group": group.trim(),
            "skills": skills
        }));
    }
    install_one(if name.is_empty() { DEFAULT_SKILL_NAME } else { name }, to, force)
}

// ─── skill get：全文 + 顺手安装 ─────────────────────────────────────

fn list_refs(dir_name: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    if let Some(dir) = ASSETS.get_dir(dir_name) {
        if let Some(refs) = dir.get_dir("references") {
            for f in refs.files() {
                let n = f.path().file_name().map(|x| x.to_string_lossy().to_string()).unwrap_or_default();
                if n.ends_with(".md") {
                    out.push(n[..n.len() - 3].to_string());
                }
            }
        }
    }
    let disk_refs = assets_dir().join(dir_name).join("references");
    if let Ok(entries) = std::fs::read_dir(&disk_refs) {
        for e in entries.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if n.ends_with(".md") && !out.contains(&n[..n.len() - 3].to_string()) {
                out.push(n[..n.len() - 3].to_string());
            }
        }
    }
    if out.is_empty() { "(无)".into() } else { out.join(", ") }
}

fn content_one(name: &str, r#ref: &str, to: &str) -> Res<Value> {
    let name = assert_safe_name(&canonical_name(name), "skill 名称")?;
    if asset_file(&name, "SKILL.md").is_none() {
        let available = asset_skill_dirs().join(", ");
        return Err(not_found(format!(
            "未找到内置 skill: {}（可用: {}）",
            name,
            if available.is_empty() { "(无)".into() } else { available }
        )));
    }

    let rel: String;
    let raw = r#ref.trim();
    if raw.is_empty() {
        rel = "SKILL.md".into();
    } else {
        if raw.split(['/', '\\']).any(|s| s == "..") {
            return Err(bad_input(format!("ref 路径不允许包含 '..': {}", raw)));
        }
        if crate::core::paths::is_abs_str(raw) {
            return Err(bad_input(format!("ref 越界（必须是相对路径）: {}", raw)));
        }
        if raw.contains('/') || raw.contains('\\') || raw.starts_with("./") {
            rel = raw.trim_start_matches("./").to_string();
        } else {
            let bare = if raw.ends_with(".md") { raw.to_string() } else { format!("{}.md", raw) };
            let in_refs = format!("references/{}", bare);
            if asset_file(&name, &in_refs).is_some() {
                rel = in_refs;
            } else if asset_file(&name, &bare).is_some() {
                rel = bare;
            } else {
                return Err(bad_input(format!(
                    "未找到 ref: {}（可用: {}）",
                    raw,
                    list_refs(&name)
                )));
            }
        }
    }

    let content_bytes = asset_file(&name, &rel)
        .ok_or_else(|| not_found(format!("skill {} 里没有文件: {}", name, rel)))?;
    let content = String::from_utf8_lossy(&content_bytes).to_string();

    // get 的语义是「读」不是「修」：conflict 照常返回文档
    let install = install_one(&name, to, false)?;
    Ok(json!({
        "skillName": name,
        "ref": rel.replace('\\', "/"),
        "content": content,
        "contentBytes": content.len(),
        "install": install
    }))
}

/// `group` 给定时把该组每个 skill 的全文都取回来。
pub fn bundled_skill_content(name: &str, group: &str, r#ref: &str, to: &str) -> Res<Value> {
    if !group.trim().is_empty() {
        let g = resolve_group(group)?;
        let mut skills: Vec<Value> = Vec::new();
        for s in g["skills"].as_array().cloned().unwrap_or_default() {
            skills.push(content_one(s.as_str().unwrap_or(""), r#ref, to)?);
        }
        return Ok(json!({ "group": group.trim(), "skills": skills }));
    }
    content_one(if name.is_empty() { DEFAULT_SKILL_NAME } else { name }, r#ref, to)
}

#[allow(dead_code)]
fn _touch(p: &Path) {
    let _ = exists(p);
}
