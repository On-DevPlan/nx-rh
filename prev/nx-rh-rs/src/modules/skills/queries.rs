// 列表 / 详情 / 内容读取 —— 与 skills/svc/queries.js 对齐。

use crate::core::paths::CowStrExt;
use std::collections::BTreeMap;
use std::path::Path;

use serde_json::{json, Value};

use crate::core::errors::{not_found, Res};
use crate::core::fstree::{exists, path_exists};
use crate::core::link::detect_link_type;
use crate::core::mdoutline::{md_outline, md_stats};
use crate::core::paths::{assert_safe_name, assert_safe_rel_path, cwd_scope, project_root};
use crate::core::store::load_store;
use super::adapters::{target_dir_for, ADAPTERS};
use super::scan::{read_skill, scan_skills_root};
use super::sources::{find_source_skill, hub_info, list_all_source_skills, list_sources, source_entries_for};
use crate::modules::settings::service::get_settings;
use super::targets::{resolve_targets, scan_target_dir};

/// 来源级问题：目录不存在 / 空源 / 嵌套订阅 / 同一根重复订阅。
fn hub_problems_for(sources: &[Value]) -> Vec<Value> {
    let mut problems = Vec::new();
    for src in sources {
        let path = src["path"].as_str().unwrap_or("");
        if !src["exists"].as_bool().unwrap_or(false) {
            problems.push(json!({ "kind": "missing", "path": path, "reason": "目录不存在" }));
        } else if src["count"].as_u64().unwrap_or(0) == 0 {
            problems.push(json!({
                "kind": "empty", "path": path,
                "reason": "没有实文件 skill（空目录，或里面全是链接——链接是别处的落地副本，不算来源）"
            }));
        }
    }
    let keys: Vec<(String, String)> = sources
        .iter()
        .map(|s| {
            (
                s["path"].as_str().unwrap_or("").to_string(),
                cwd_scope(Some(Path::new(s["root"].as_str().unwrap_or("")))),
            )
        })
        .collect();
    for i in 0..keys.len() {
        for j in (i + 1)..keys.len() {
            let (a_path, a_key) = &keys[i];
            let (b_path, b_key) = &keys[j];
            let sep = std::path::MAIN_SEPARATOR.to_string();
            if a_key == b_key {
                problems.push(json!({
                    "kind": "same-root", "path": b_path,
                    "reason": format!("与 {} 解析到同一个 skills 根（重复订阅）", a_path)
                }));
            } else if b_key.starts_with(&format!("{}{}", a_key, sep)) {
                problems.push(json!({
                    "kind": "nested", "path": b_path,
                    "reason": format!("位于 {} 之内（嵌套订阅，会重复计数）", a_path)
                }));
            } else if a_key.starts_with(&format!("{}{}", b_key, sep)) {
                problems.push(json!({
                    "kind": "nested", "path": a_path,
                    "reason": format!("位于 {} 之内（嵌套订阅，会重复计数）", b_path)
                }));
            }
        }
    }
    problems
}

/// 订阅配置的诊断（与目的仓库无关）。
pub fn source_audit() -> Res<Value> {
    let listing = list_sources()?;
    let current = listing["current"].clone();
    let sources = listing["sources"].clone();
    let sources_arr = sources.as_array().cloned().unwrap_or_default();
    let hub_problems = hub_problems_for(&sources_arr);

    let mut by_name: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for src in &sources_arr {
        if !src["exists"].as_bool().unwrap_or(false) {
            continue;
        }
        let root = src["root"].as_str().unwrap_or("");
        let src_path = src["path"].as_str().unwrap_or("");
        let is_current = src_path == current.as_str().unwrap_or("");
        for sk in scan_skills_root(Path::new(root), None, true) {
            let name = sk["name"].as_str().unwrap_or_default().to_string();
            by_name.entry(name).or_default().push(json!({
                "source": src_path,
                "dir": sk["dir"],
                "md5": sk["md5"],
                "current": is_current,
            }));
        }
    }
    let mut conflicts: Vec<Value> = Vec::new();
    for (name, entries) in by_name {
        if entries.len() < 2 {
            continue;
        }
        let first_md5 = entries[0]["md5"].as_str().unwrap_or("");
        let same = entries.iter().all(|e| e["md5"].as_str() == Some(first_md5));
        conflicts.push(json!({
            "name": name,
            "kind": if same { "duplicate" } else { "conflict" },
            "same": same,
            "entries": entries,
        }));
    }
    let real_conflicts = conflicts.iter().filter(|c| !c["same"].as_bool().unwrap_or(false)).count();
    let duplicates = conflicts.len() - real_conflicts;
    Ok(json!({
        "current": current,
        "sources": sources,
        "hubProblems": hub_problems,
        "conflicts": conflicts,
        "ok": hub_problems.is_empty() && real_conflicts == 0,
        "summary": {
            "sources": sources_arr.len(),
            "hubProblems": hub_problems.len(),
            "conflicts": real_conflicts,
            "duplicates": duplicates,
        }
    }))
}

/// 每行 = 一个订阅源 skill（只统计实文件），带各目标迁移状态与跨源冲突。
pub fn list_all_skills(project: &str, source: &str, platform: &str) -> Res<Value> {
    let s = get_settings();
    let listing = list_sources()?;
    let current = listing["current"].as_str().unwrap_or("").to_string();
    let sources = listing["sources"].clone();

    let mut scanned: Vec<Value> = Vec::new();
    for src in sources.as_array().cloned().unwrap_or_default() {
        if !source.is_empty()
            && !src["path"].as_str().unwrap_or("").eq_ignore_ascii_case(source)
        {
            continue;
        }
        if !src["exists"].as_bool().unwrap_or(false) {
            continue;
        }
        let root = src["root"].as_str().unwrap_or("");
        scanned.extend(scan_skills_root(
            Path::new(root),
            Some(src["path"].as_str().unwrap_or("")),
            true,
        ));
    }

    // 跨源聚合：同名 = 冲突候选
    let mut by_name: BTreeMap<String, Value> = BTreeMap::new();
    for sk in &scanned {
        let name = sk["name"].as_str().unwrap_or_default().to_string();
        let entry = by_name.entry(name).or_insert_with(|| {
            json!({
                "name": sk["name"],
                "description": sk["description"],
                "dir": sk["dir"],
                "md5": sk["md5"],
                "lastModified": sk["lastModified"],
                "source": sk["source"],
                "sources": []
            })
        });
        entry["sources"].as_array_mut().unwrap().push(json!({
            "path": sk["source"],
            "dir": sk["dir"],
            "md5": sk["md5"],
        }));
        if sk["source"].as_str() == Some(&current) {
            entry["source"] = sk["source"].clone();
            entry["dir"] = sk["dir"].clone();
            entry["md5"] = sk["md5"].clone();
            entry["description"] = sk["description"].clone();
        }
    }
    let mut conflicts: Vec<Value> = Vec::new();
    for (name, e) in &by_name {
        let sources_list = e["sources"].as_array().cloned().unwrap_or_default();
        if sources_list.len() < 2 {
            continue;
        }
        let first = sources_list[0]["md5"].as_str().unwrap_or("");
        let same = sources_list.iter().all(|x| x["md5"].as_str() == Some(first));
        conflicts.push(json!({
            "name": name, "kind": if same { "duplicate" } else { "conflict" },
            "same": same, "sources": sources_list
        }));
    }
    conflicts.sort_by(|a, b| {
        a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or(""))
    });

    let targets = resolve_targets("all", platform, project)?;
    let targets_arr = targets.as_array().cloned().unwrap_or_default();
    let mut rows: Vec<Value> = Vec::new();
    let mut sorted_names: Vec<&String> = by_name.keys().collect();
    sorted_names.sort();
    for name in sorted_names {
        let sk = &by_name[name];
        let mut cells: Vec<Value> = Vec::new();
        for t in &targets_arr {
            let tdir = t["dir"].as_str().unwrap_or("");
            let p = Path::new(tdir).join(name);
            let on = path_exists(&p);
            cells.push(json!({
                "platform": t["platform"],
                "platformName": t["platformName"],
                "scope": t["scope"],
                "dir": p.to_string_lossy().native(),
                "on": on,
                "linkType": if on { detect_link_type(&p) } else { String::new() },
            }));
        }
        let conflict = conflicts.iter().find(|c| c["name"].as_str() == Some(name)).cloned();
        let up = upstream_of(name);
        let mut row = sk.clone();
        row["cells"] = json!(cells);
        row["current"] = json!(sk["source"].as_str() == Some(&current));
        row["conflict"] = conflict.unwrap_or(Value::Null);
        row["upstream"] = up;
        rows.push(row);
    }

    // 目标目录里存在、但订阅源没有的 skill —— 待「提交到 Hub」
    let source_names: std::collections::HashSet<String> =
        rows.iter().map(|r| r["name"].as_str().unwrap_or("").to_string()).collect();
    let mut orphan_map: BTreeMap<String, Value> = BTreeMap::new();
    for t in &targets_arr {
        let tdir = t["dir"].as_str().unwrap_or("");
        for sk in scan_target_dir(tdir, t["platform"].as_str().unwrap_or(""), t["scope"].as_str().unwrap_or("")) {
            let name = sk["name"].as_str().unwrap_or_default().to_string();
            if source_names.contains(&name) {
                continue;
            }
            let entry = orphan_map.entry(name).or_insert_with(|| {
                json!({
                    "name": sk["name"],
                    "description": sk["description"],
                    "md5": sk["md5"],
                    "cells": []
                })
            });
            entry["cells"].as_array_mut().unwrap().push(json!({
                "platform": t["platform"],
                "platformName": t["platformName"],
                "scope": t["scope"],
                "dir": Path::new(tdir).join(sk["name"].as_str().unwrap_or("")).to_string_lossy().native(),
                "on": true,
                "linkType": sk["linkType"],
            }));
        }
    }

    // 全平台汇总（总览页用）
    let proj_root = if project.is_empty() {
        project_root().to_string_lossy().to_string()
    } else {
        project.to_string()
    };
    let mut platform_summary: Vec<Value> = Vec::new();
    let mut proj_names: std::collections::HashSet<String> = std::collections::HashSet::new();
    for a in ADAPTERS {
        let mut rec = json!({
            "id": a.id, "name": a.name,
            "enabled": crate::core::store::to_array_setting(&s["platforms"]).iter().any(|p| p == a.id),
            "isDefault": s["defaultPlatform"].as_str() == Some(a.id),
            "managed": 0, "orphan": 0, "copies": 0, "links": 0, "user": 0, "project": 0,
        });
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        for sc in ["user", "project"] {
            let Some(dir) = target_dir_for(a.id, sc, &proj_root) else { continue };
            let found = scan_skills_root(Path::new(&dir), None, false);
            if !found.is_empty() {
                rec[sc] = json!(found.len());
            }
            for x in &found {
                let xname = x["name"].as_str().unwrap_or_default().to_string();
                if !x["linkType"].as_str().unwrap_or("").is_empty() {
                    rec["links"] = json!(rec["links"].as_u64().unwrap_or(0) + 1);
                } else {
                    rec["copies"] = json!(rec["copies"].as_u64().unwrap_or(0) + 1);
                }
                if seen.contains(&xname) {
                    continue;
                }
                seen.insert(xname.clone());
                if source_names.contains(&xname) {
                    rec["managed"] = json!(rec["managed"].as_u64().unwrap_or(0) + 1);
                } else {
                    rec["orphan"] = json!(rec["orphan"].as_u64().unwrap_or(0) + 1);
                }
                if sc == "project" {
                    proj_names.insert(xname);
                }
            }
        }
        platform_summary.push(rec);
    }

    let orphans: Vec<Value> = {
        let mut v: Vec<Value> = orphan_map.into_values().collect();
        v.sort_by(|a, b| a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or("")));
        v
    };
    let orphan_in_proj = proj_names.iter().filter(|n| !source_names.contains(*n)).count();

    Ok(json!({
        "hub": merge_hub(&Value::String(current.clone())),
        "settings": {
            "platforms": s["platforms"],
            "defaultPlatform": s["defaultPlatform"],
            "syncMode": s["skillSyncMode"]
        },
        "sources": sources,
        "hubProblems": hub_problems_for(sources.as_array().unwrap_or(&Vec::new())),
        "conflicts": conflicts,
        "skills": rows,
        "orphans": orphans,
        "platformSummary": platform_summary,
        "projectSummary": {
            "root": proj_root,
            "count": proj_names.len(),
            "orphan": orphan_in_proj
        }
    }))
}

fn merge_hub(current: &Value) -> Value {
    let info = hub_info();
    let mut merged = info.clone();
    if let Some(obj) = merged.as_object_mut() {
        obj.insert("path".into(), current.clone());
    }
    merged
}

/// 当前项目目录里的 skill：扫全部适配器的项目级目录。
pub fn list_project_skills(project: &str) -> Res<Value> {
    let s = get_settings();
    let proj_root = if project.is_empty() {
        project_root().to_string_lossy().to_string()
    } else {
        project.to_string()
    };
    let source_names: std::collections::HashSet<String> =
        list_all_source_skills()?.iter().map(|x| x["name"].as_str().unwrap_or("").to_string()).collect();
    let mut dirs: Vec<Value> = Vec::new();
    let mut by_name: BTreeMap<String, Value> = BTreeMap::new();
    for a in ADAPTERS {
        let Some(dir) = target_dir_for(a.id, "project", &proj_root) else { continue };
        let found = scan_skills_root(Path::new(&dir), None, false);
        if found.is_empty() && !path_exists(Path::new(&dir)) {
            continue;
        }
        let enabled = crate::core::store::to_array_setting(&s["platforms"]).iter().any(|p| p == a.id);
        dirs.push(json!({
            "platform": a.id,
            "platformName": a.name,
            "dir": dir,
            "enabled": enabled,
            "isDefault": s["defaultPlatform"].as_str() == Some(a.id),
            "skills": found.iter().map(|x| {
                let mut row = x.clone();
                row["inHub"] = json!(source_names.contains(x["name"].as_str().unwrap_or("")));
                row
            }).collect::<Vec<_>>()
        }));
        for sk in &found {
            let name = sk["name"].as_str().unwrap_or_default().to_string();
            let entry = by_name.entry(name).or_insert_with(|| {
                json!({
                    "name": sk["name"],
                    "description": sk["description"],
                    "inHub": source_names.contains(sk["name"].as_str().unwrap_or("")),
                    "cells": []
                })
            });
            entry["cells"].as_array_mut().unwrap().push(json!({
                "platform": a.id,
                "platformName": a.name,
                "dir": sk["dir"],
                "linkType": sk["linkType"],
                "enabled": enabled,
            }));
        }
    }
    let mut skills: Vec<Value> = by_name.into_values().collect();
    skills.sort_by(|a, b| a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or("")));
    Ok(json!({
        "projectRoot": proj_root,
        "dirs": dirs,
        "skills": skills
    }))
}

/// 解析一个 skill 的「可读目录」：主源 → 其它订阅源 → 平台目录安装位置。
pub fn resolve_skill_dir(name: &str, project: &str) -> Res<Value> {
    let name = assert_safe_name(name, "skill 名称")?;
    let entries = source_entries_for(&name)?;
    if !entries.is_empty() {
        let mut hit = entries[0].clone();
        if entries.len() > 1 {
            hit["alsoIn"] = json!(entries[1..].iter().map(|e| e["source"].clone()).collect::<Vec<_>>());
        }
        return Ok(json!({
            "name": name,
            "dir": hit["dir"],
            "origin": "source",
            "source": hit["source"],
            "alsoIn": hit.get("alsoIn").cloned().unwrap_or(json!([])),
            "broken": false,
            "linkType": "",
            "linkTarget": "",
        }));
    }
    let mut dead: Option<Value> = None;
    let targets = resolve_targets("all", "", project)?;
    for t in targets.as_array().cloned().unwrap_or_default() {
        let p = Path::new(t["dir"].as_str().unwrap_or("")).join(&name);
        if !path_exists(&p) {
            continue; // lstat：悬空链接也算存在
        }
        let link_type = detect_link_type(&p);
        let mut place = json!({
            "name": name,
            "dir": p.to_string_lossy().native(),
            "origin": if link_type.is_empty() { "target" } else { "link" },
            "source": "",
            "platform": t["platform"],
            "platformName": t["platformName"],
            "scope": t["scope"],
            "linkType": link_type,
            "linkTarget": if link_type.is_empty() { json!("") } else { json!(read_link_lossy(&p)) },
            "broken": false,
            "alsoIn": []
        });
        if exists(&p.join("SKILL.md")) {
            return Ok(place);
        }
        place["broken"] = json!(true);
        if dead.is_none() {
            dead = Some(place);
        }
    }
    if let Some(d) = dead {
        return Ok(d);
    }
    Err(not_found(format!(
        "未找到 skill: {}（订阅源与各平台目录里都没有）",
        name
    )))
}

fn read_link_lossy(p: &Path) -> String {
    std::fs::read_link(p)
        .map(|t| t.to_string_lossy().to_string())
        .unwrap_or_default()
}

const SKIP_DIRS: [&str; 8] =
    [".git", "node_modules", ".turbo", "dist", ".next", "__pycache__", ".venv", ".turbo"];
const FILE_LIST_MAX: usize = 500;

/// 一个 skill 目录下的文件清单（相对路径）。跳过噪音目录、不跟随目录内链接。
fn list_skill_files(root: &Path) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    fn walk(dir: &Path, prefix: &str, out: &mut Vec<Value>) {
        if out.len() >= FILE_LIST_MAX {
            return;
        }
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        let mut items: Vec<(String, std::fs::DirEntry)> = entries
            .flatten()
            .map(|e| (e.file_name().to_string_lossy().to_string(), e))
            .collect();
        items.sort_by(|a, b| a.0.cmp(&b.0));
        for (name, e) in items {
            if out.len() >= FILE_LIST_MAX {
                return;
            }
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_symlink() || SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            let rel = if prefix.is_empty() { name.clone() } else { format!("{}/{}", prefix, name) };
            let abs = dir.join(&name);
            if ft.is_dir() {
                walk(&abs, &rel, out);
                continue;
            }
            if !ft.is_file() {
                continue;
            }
            let size = std::fs::metadata(&abs).map(|m| m.len()).unwrap_or(0);
            out.push(json!({ "path": rel, "bytes": size }));
        }
    }
    walk(root, "", &mut out);
    // SKILL.md 永远排第一（不区分大小写）；其余按字典序
    out.sort_by(|a, b| {
        let am = a["path"].as_str().unwrap_or("").to_lowercase() == "skill.md";
        let bm = b["path"].as_str().unwrap_or("").to_lowercase() == "skill.md";
        match (am, bm) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a["path"].as_str().unwrap_or("").cmp(b["path"].as_str().unwrap_or("")),
        }
    });
    out
}

/// 单个 skill 的详情（来源 + 完整描述 + 安装位置形态 + 文件清单）。
pub fn skill_info(name: &str, project: &str) -> Res<Value> {
    let name = assert_safe_name(name, "skill 名称")?;
    let found = find_source_skill(&name)?;
    let targets = resolve_targets("all", "", project)?;
    let mut cells: Vec<Value> = Vec::new();
    for t in targets.as_array().cloned().unwrap_or_default() {
        let p = Path::new(t["dir"].as_str().unwrap_or("")).join(&name);
        let on = path_exists(&p);
        cells.push(json!({
            "platform": t["platform"],
            "platformName": t["platformName"],
            "scope": t["scope"],
            "dir": p.to_string_lossy().native(),
            "on": on,
            "linkType": if on { detect_link_type(&p) } else { String::new() },
        }));
    }
    if found.is_none() && !cells.iter().any(|c| c["on"].as_bool().unwrap_or(false)) {
        return Err(not_found(format!("未找到 skill: {}", name)));
    }

    let place = resolve_skill_dir(&name, project).ok();
    let dir = place
        .as_ref()
        .and_then(|p| p["dir"].as_str())
        .unwrap_or("")
        .to_string();
    let broken = place.as_ref().and_then(|p| p["broken"].as_bool()).unwrap_or(false);
    let raw = if !dir.is_empty() && !broken {
        std::fs::read_to_string(Path::new(&dir).join("SKILL.md")).unwrap_or_default()
    } else {
        String::new()
    };
    let outline = md_outline(&raw, 3);
    let local = if !dir.is_empty() && found.is_none() && !broken {
        read_skill(Path::new(&dir))
    } else {
        None
    };
    // 跨源冲突（只看订阅源之间）
    let entries = source_entries_for(&name)?;
    let conflict = if entries.len() > 1 {
        let first = entries[0]["md5"].as_str().unwrap_or("");
        json!({
            "same": entries.iter().all(|e| e["md5"].as_str() == Some(first)),
            "sources": entries.iter().map(|e| json!({
                "path": e["source"], "dir": e["dir"], "md5": e["md5"]
            })).collect::<Vec<_>>()
        })
    } else {
        Value::Null
    };
    Ok(json!({
        "name": name,
        "description": match &found {
            Some(f) => f["description"].clone(),
            None => local.as_ref().map(|l| l["description"].clone()).unwrap_or(json!("(无描述)")),
        },
        "source": found.as_ref().map(|f| f["source"].clone()).unwrap_or(json!("")),
        "origin": place.as_ref().and_then(|p| p["origin"].as_str()).unwrap_or(""),
        "dir": if broken { place.as_ref().map(|p| p["dir"].clone()).unwrap_or(json!("")) } else { json!(dir) },
        "linkTarget": place.as_ref().and_then(|p| p["linkTarget"].as_str()).unwrap_or(""),
        "broken": broken,
        "alsoIn": found.as_ref().and_then(|f| f.get("alsoIn").cloned()).unwrap_or(json!([])),
        "md5": match &found {
            Some(f) => f["md5"].clone(),
            None => local.as_ref().map(|l| l["md5"].clone()).unwrap_or(json!("")),
        },
        "upstream": upstream_of(&name),
        "conflict": conflict,
        "outline": outline,
        "stats": md_stats(&raw, &outline),
        "files": if !dir.is_empty() && !broken { list_skill_files(Path::new(&dir)) } else { vec![] },
        "cells": cells,
    }))
}

/// 某个 skill 的上游元数据；不在远程仓库里返回 null。
pub fn upstream_of(name: &str) -> Value {
    let st = load_store();
    let meta = st.pointer(&format!(
        "/remoteRepo/skills/{}",
        super::remote_repo::json_pointer_escape(name)
    ));
    let Some(meta) = meta else {
        return Value::Null;
    };
    json!({
        "spec": meta["spec"].as_str().unwrap_or(""),
        "url": meta["url"].as_str().unwrap_or(""),
        "ref": meta["ref"].as_str().unwrap_or(""),
        "hash": meta["hash"].as_str().unwrap_or(""),
        "importedAt": meta["importedAt"].as_str().unwrap_or(""),
        "updatedAt": meta["updatedAt"].as_str().unwrap_or(meta["importedAt"].as_str().unwrap_or("")),
        "link": meta["link"].as_str().unwrap_or(""),
        "manual": meta["spec"].as_str().map(|s| s.is_empty()).unwrap_or(true),
    })
}

/// `skill cat`：SKILL.md 或某个 reference 的全文。
pub fn skill_content(name: &str, r#ref: &str, project: &str) -> Res<Value> {
    let name = assert_safe_name(name, "skill 名称")?;
    let place = resolve_skill_dir(&name, project)?;
    if place["broken"].as_bool().unwrap_or(false) {
        return Err(not_found(format!(
            "skill {} 的安装位置是断链：{}{}（目标已不存在）",
            name,
            place["dir"].as_str().unwrap_or(""),
            match place["linkTarget"].as_str().unwrap_or("") {
                "" => String::new(),
                t => format!(" → {}", t),
            }
        )));
    }
    let file = if r#ref.is_empty() {
        "SKILL.md".to_string()
    } else {
        assert_safe_rel_path(r#ref, "ref 路径", true)?
    };
    let abs = Path::new(place["dir"].as_str().unwrap_or("")).join(&file);
    let content = std::fs::read_to_string(&abs)
        .map_err(|_| not_found(format!("skill {} 里没有文件: {}", name, file)))?;
    let outline = md_outline(&content, 3);
    Ok(json!({
        "skillName": name,
        "source": place["source"],
        "origin": place["origin"],
        "dir": place["dir"],
        "linkType": place["linkType"].as_str().unwrap_or(""),
        "ref": file,
        "content": content,
        "contentBytes": content.len(),
        "outline": outline,
        "stats": md_stats(&content, &outline),
        "upstream": upstream_of(&name),
    }))
}
