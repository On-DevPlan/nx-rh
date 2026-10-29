// 远程订阅仓库：唯一一个装着「外部 skill」的容器 —— 与 skills/svc/remote-repo.js 对齐。
// 目录布局 <repo>/<name>/SKILL.md；实体 + 软链；每个实体带来源与版本元数据。

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::core::errors::{bad_input, conflict, not_found, Res};
use crate::core::fstree::{copy_dir_dereference, path_exists, rm_force};
use crate::core::link::{create_skill_link, detect_link_type};
use crate::core::paths::{assert_safe_name, remote_repo_dir};
use crate::core::store::{load_store, mutate_store};
use super::scan::{read_skill, resolve_skills_root, scan_skills_root, skill_dir_hash};
use super::targets;

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// 远程订阅仓库目录 + 登记为订阅源（幂等）。
pub fn ensure_remote() -> Res<String> {
    let dir = remote_repo_dir();
    std::fs::create_dir_all(&dir).map_err(crate::core::errors::io_err)?;
    let dir_str = dir.to_string_lossy().to_string();
    mutate_store(|s| {
        s["remoteRepo"]["dir"] = json!(dir_str);
        let list = to_arr(&s["settings"]["skillHubSources"]);
        if !list.iter().any(|p| p.eq_ignore_ascii_case(&dir_str)) {
            let mut next = list;
            next.push(dir_str.clone());
            s["settings"]["skillHubSources"] = json!(next);
        }
        Ok(dir_str)
    })
}

fn to_arr(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str()).map(|s| s.to_string()).collect())
        .unwrap_or_default()
}

pub fn remote_repo_state() -> Value {
    let s = load_store();
    match s.get("remoteRepo") {
        Some(r) if r.is_object() => r.clone(),
        _ => json!({ "dir": remote_repo_dir().to_string_lossy(), "skills": {} }),
    }
}

fn repo_dir_of(st: &Value) -> PathBuf {
    let d = st["dir"].as_str().unwrap_or("");
    if d.is_empty() {
        remote_repo_dir()
    } else {
        PathBuf::from(d)
    }
}

/// 远程订阅仓库里的 skill 清单：实体 + 软链，各带版本元数据。
pub fn remote_contents() -> Res<Value> {
    let st = remote_repo_state();
    let dir = repo_dir_of(&st);
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(json!({ "dir": dir.to_string_lossy(), "skills": [] })),
    };
    let mut names: Vec<String> = entries
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    names.sort();

    let mut skills: Vec<Value> = Vec::new();
    for name in names {
        if name.starts_with('.') {
            continue;
        }
        let path = dir.join(&name);
        let Ok(lst) = std::fs::symlink_metadata(&path) else { continue };
        if !lst.is_dir() && !lst.is_symlink() {
            continue;
        }
        let Some(info) = read_skill(&path) else { continue };
        let meta = st.pointer(&format!("/skills/{}", json_pointer_escape(&name))).cloned().unwrap_or(json!({}));
        let link_type = detect_link_type(&path);
        let hash = meta["hash"]
            .as_str()
            .map(|s| s.to_string())
            .unwrap_or_else(|| skill_dir_hash(&path));
        skills.push(json!({
            "name": name,
            "description": info["description"],
            "dir": path.to_string_lossy().replace('/', "\\"),
            "linkType": link_type,
            "hash": hash,
            "spec": meta["spec"].as_str().unwrap_or(""),
            "url": meta["url"].as_str().unwrap_or(""),
            "ref": meta["ref"].as_str().unwrap_or(""),
            "importedAt": meta["importedAt"].as_str().unwrap_or(""),
            "updatedAt": meta["updatedAt"].as_str().unwrap_or(meta["importedAt"].as_str().unwrap_or("")),
            "manual": meta["spec"].as_str().map(|s| s.is_empty()).unwrap_or(true),
        }));
    }
    Ok(json!({ "dir": dir.to_string_lossy().replace('/', "\\"), "skills": skills }))
}

pub fn json_pointer_escape(s: &str) -> String {
    s.replace('~', "~0").replace('/', "~1")
}

/// 远程订阅内容 + 安装状态（cells）：与本地源的 skill 行同投影。
pub fn remote_contents_with_cells(project: &str) -> Res<Value> {
    let contents = remote_contents()?;
    let all_targets = targets::resolve_targets("all", "", project)?;
    let targets_arr = all_targets.as_array().cloned().unwrap_or_default();
    let mut skills: Vec<Value> = Vec::new();
    for s in contents["skills"].as_array().cloned().unwrap_or_default() {
        let name = s["name"].as_str().unwrap_or_default().to_string();
        let mut cells: Vec<Value> = Vec::new();
        for t in &targets_arr {
            let tdir = t["dir"].as_str().unwrap_or("");
            let p = Path::new(tdir).join(&name);
            let on = path_exists(&p);
            cells.push(json!({
                "platform": t["platform"],
                "platformName": t["platformName"],
                "scope": t["scope"],
                "dir": p.to_string_lossy().replace('/', "\\"),
                "on": on,
                "linkType": if on { detect_link_type(&p) } else { String::new() },
            }));
        }
        let mut row = s.clone();
        row["cells"] = json!(cells);
        skills.push(row);
    }
    Ok(json!({
        "dir": contents["dir"],
        "skills": skills
    }))
}

/// 导入：把远程规格里的 skill 拉进远程订阅仓库。
pub fn import_to_remote(spec: &str, name: Option<&str>, dry_run: bool) -> Res<Value> {
    let mut parsed = super::remote_parse::parse_source(spec)?;
    if parsed["type"] == "local" {
        return Err(bad_input(
            "远程订阅仓库只收远程规格（owner/repo、git URL、归档 URL）；手写定义用 skill hub remote add",
        ));
    }
    parsed["spec"] = json!(spec);
    let m = super::remote::materialize_remote(&parsed)?;
    let result = (|| -> Res<Value> {
        let root = resolve_skills_root(&m.source_dir);
        let skills = scan_skills_root(&root, None, true);
        if skills.is_empty() {
            return Err(bad_input(format!("上游里没有找到 skill: {}", spec)));
        }
        let wanted: Vec<Value> = match name {
            Some(n) => {
                let hit: Vec<Value> = skills
                    .iter()
                    .filter(|s| s["name"].as_str() == Some(n))
                    .cloned()
                    .collect();
                if hit.is_empty() {
                    return Err(not_found(format!("上游里没有这个 skill: {}（{}）", n, spec)));
                }
                hit
            }
            None => skills.clone(),
        };

        if dry_run {
            let mut preview: Vec<Value> = Vec::new();
            for sk in &wanted {
                let sk_name = sk["name"].as_str().unwrap_or_default();
                let safe = assert_safe_name(sk_name, "上游 skill 名称")?;
                preview.push(json!({
                    "name": safe,
                    "description": sk["description"],
                    "hash": skill_dir_hash(Path::new(sk["dir"].as_str().unwrap_or(""))),
                }));
            }
            preview.sort_by(|a, b| {
                a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or(""))
            });
            return Ok(json!({
                "status": "ok", "dryRun": true, "spec": spec, "dir": "",
                "url": parsed["url"], "ref": parsed["ref"].as_str().unwrap_or(""),
                "skills": preview, "count": preview.len()
            }));
        }

        let dir = ensure_remote()?;
        let stamp = now_iso();
        let mut imported: Vec<Value> = Vec::new();
        for sk in &wanted {
            let sk_name = sk["name"].as_str().unwrap_or_default();
            let safe = assert_safe_name(sk_name, "上游 skill 名称")?;
            let src_dir = PathBuf::from(sk["dir"].as_str().unwrap_or(""));
            let hash = skill_dir_hash(&src_dir);
            let target = Path::new(&dir).join(&safe);
            rm_force(&target);
            copy_dir_dereference(&src_dir, &target)?;
            imported.push(json!({
                "name": safe,
                "description": sk["description"],
                "hash": hash,
                "spec": spec,
                "url": parsed["url"],
                "ref": parsed["ref"].as_str().unwrap_or(""),
                "skillPath": src_dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
            }));
        }
        mutate_store(|s| {
            s["remoteRepo"]["dir"] = json!(dir);
            for it in &imported {
                let name = it["name"].as_str().unwrap_or_default().to_string();
                let prev = s
                    .pointer(&format!("/remoteRepo/skills/{}", json_pointer_escape(&name)))
                    .cloned()
                    .unwrap_or(json!({}));
                let mut entry = it.clone();
                entry["importedAt"] = json!(prev["importedAt"].as_str().unwrap_or(&stamp));
                entry["updatedAt"] = json!(stamp);
                s["remoteRepo"]["skills"][json_pointer_escape(&name)] = entry;
            }
            Ok(Value::Null)
        })?;
        let names: Vec<String> = imported
            .iter()
            .filter_map(|i| i["name"].as_str().map(|s| s.to_string()))
            .collect();
        Ok(json!({ "dir": dir, "spec": spec, "imported": names, "count": names.len() }))
    })();
    rm_force(&m.staging);
    result
}

/// 手工添加定义：在远程订阅仓库里新建一个 skill。
pub fn add_remote_definition(name: &str, description: Option<&str>, content: Option<&str>) -> Res<Value> {
    if name.is_empty() {
        return Err(bad_input(
            "用法: nx-rh-rs skill hub remote add <name> [--description <描述>] [--content <正文>]",
        ));
    }
    let safe = assert_safe_name(name, "skill 名称")?;
    let dir = ensure_remote()?;
    let target = Path::new(&dir).join(&safe);
    if target.exists() {
        return Err(conflict(format!("远程订阅仓库里已经有这个 skill: {}", safe)));
    }
    let desc = description.unwrap_or("（手工添加的定义）");
    let body = content.map(|c| c.to_string()).unwrap_or_else(|| format!("# {}\n", safe));
    let md = format!("---\nname: {}\ndescription: {}\n---\n\n{}\n", safe, desc, body);
    std::fs::create_dir_all(&target).map_err(crate::core::errors::io_err)?;
    std::fs::write(target.join("SKILL.md"), md).map_err(crate::core::errors::io_err)?;
    let hash = skill_dir_hash(&target);
    let stamp = now_iso();
    mutate_store(|s| {
        s["remoteRepo"]["dir"] = json!(dir);
        s["remoteRepo"]["skills"][json_pointer_escape(&safe)] = json!({
            "name": safe, "description": desc, "hash": hash,
            "spec": "", "url": "", "ref": "", "skillPath": safe,
            "importedAt": stamp, "updatedAt": stamp,
        });
        Ok(Value::Null)
    })?;
    Ok(json!({ "dir": dir, "name": safe, "hash": hash, "imported": [safe] }))
}

/// 链入：把别处已有的 skill 软链**进**远程订阅仓库。
pub fn link_into_remote(name: &str, target: &str) -> Res<Value> {
    if name.is_empty() || target.is_empty() {
        return Err(bad_input("用法: nx-rh-rs skill hub remote link <name> <目标目录>"));
    }
    let safe = assert_safe_name(name, "软链名")?;
    let dir = ensure_remote()?;
    let link = Path::new(&dir).join(&safe);
    if std::fs::symlink_metadata(&link).is_ok() {
        return Err(conflict(format!("远程订阅仓库里已经有这个名字: {}", safe)));
    }
    let info = read_skill(Path::new(target))
        .ok_or_else(|| not_found(format!("目标目录里没有 SKILL.md: {}", target)))?;
    let r = create_skill_link(Path::new(target), &link);
    if !r.ok {
        return Err(external_err(r.error.unwrap_or_default()));
    }
    let hash = skill_dir_hash(Path::new(target));
    let stamp = now_iso();
    mutate_store(|s| {
        s["remoteRepo"]["dir"] = json!(dir);
        s["remoteRepo"]["skills"][json_pointer_escape(&safe)] = json!({
            "name": safe, "description": info["description"], "hash": hash,
            "spec": "", "url": "", "ref": "", "skillPath": safe,
            "importedAt": stamp, "updatedAt": stamp, "link": target,
        });
        Ok(Value::Null)
    })?;
    let lt = detect_link_type(&link);
    Ok(json!({ "dir": dir, "name": safe, "target": target, "linkType": if lt.is_empty() { "symlink".to_string() } else { lt } }))
}

fn external_err(msg: String) -> crate::core::errors::AppError {
    crate::core::errors::app_error("EXTERNAL", msg)
}

/// 链出：把远程订阅仓库里的某份 skill 链到别处。
pub fn link_from_remote(name: &str, target: &str) -> Res<Value> {
    let safe = assert_safe_name(name, "skill 名称")?;
    let st = remote_repo_state();
    let dir = repo_dir_of(&st);
    let src = dir.join(&safe);
    if std::fs::symlink_metadata(&src).is_err() {
        return Err(not_found(format!("远程订阅仓库里没有这个 skill: {}", safe)));
    }
    if std::fs::symlink_metadata(target).is_ok() {
        return Err(conflict(format!("目标位置已存在: {}", target)));
    }
    if let Some(parent) = Path::new(target).parent() {
        std::fs::create_dir_all(parent).map_err(crate::core::errors::io_err)?;
    }
    let r = create_skill_link(&src, Path::new(target));
    if !r.ok {
        return Err(external_err(r.error.unwrap_or_default()));
    }
    let lt = detect_link_type(Path::new(target));
    Ok(json!({
        "name": safe, "from": src.to_string_lossy().replace('/', "\\"),
        "to": target, "linkType": if lt.is_empty() { "symlink".to_string() } else { lt }
    }))
}

/// 更新：按来源重拉，逐 skill 比对指纹——变了才换。
pub fn update_remote(names: &[String], prune: bool) -> Res<Value> {
    let st = remote_repo_state();
    let skills = st["skills"].clone();
    let entries: Vec<(String, Value)> = skills
        .as_object()
        .map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default();
    let targets: Vec<(String, Value)> = if !names.is_empty() {
        entries.into_iter().filter(|(n, _)| names.contains(n)).collect()
    } else {
        entries
    };
    if targets.is_empty() {
        return Ok(json!({
            "status": "ok", "results": [],
            "note": "远程订阅仓库里还没有可更新的 skill（先 import 或 add）"
        }));
    }
    // 同一来源只拉一次
    let mut by_spec: Vec<(String, Vec<(String, Value)>)> = Vec::new();
    for (name, meta) in &targets {
        let spec = meta["spec"].as_str().unwrap_or("").to_string();
        if spec.is_empty() {
            continue;
        }
        match by_spec.iter_mut().find(|(s, _)| *s == spec) {
            Some((_, items)) => items.push((name.clone(), meta.clone())),
            None => by_spec.push((spec, vec![(name.clone(), meta.clone())])),
        }
    }

    let mut results: Vec<Value> = Vec::new();
    // 没有 spec 的先报 skipped
    for (name, meta) in &targets {
        if meta["spec"].as_str().unwrap_or("").is_empty() {
            results.push(json!({
                "name": name, "status": "skipped",
                "reason": "手工定义 / 软链，没有上游可更新"
            }));
        }
    }

    for (spec, items) in &by_spec {
        let mut staging: Option<PathBuf> = None;
        let outcome: Res<()> = (|| {
            let mut parsed = super::remote_parse::parse_source(spec)?;
            parsed["spec"] = json!(spec);
            let m = super::remote::materialize_remote(&parsed)?;
            staging = Some(m.staging.clone());
            let root = resolve_skills_root(&m.source_dir);
            let upstream = scan_skills_root(&root, None, true);
            for (name, meta) in items {
                let up = upstream
                    .iter()
                    .find(|s| s["name"].as_str() == Some(name.as_str()))
                    .or_else(|| {
                        // 重定位：按原目录名（skillPath）找一次
                        let skill_path = meta["skillPath"].as_str().unwrap_or("");
                        upstream.iter().find(|s| {
                            Path::new(s["dir"].as_str().unwrap_or(""))
                                .file_name()
                                .map(|n| n.to_string_lossy() == skill_path)
                                .unwrap_or(false)
                        })
                    });
                let Some(up) = up else {
                    let mut row = json!({
                        "name": name, "status": "removed",
                        "reason": "上游已没有这个 skill（frontmatter name 与原目录都对不上）"
                    });
                    if prune {
                        let target = repo_dir_of(&st).join(name);
                        rm_force(&target);
                        let _ = mutate_store(|s| {
                            if let Some(obj) = s.pointer_mut("/remoteRepo/skills").and_then(|o| o.as_object_mut()) {
                                obj.remove(name);
                            }
                            Ok(Value::Null)
                        });
                        row["pruned"] = json!(true);
                    }
                    results.push(row);
                    continue;
                };
                let relocated = upstream.iter().find(|s| s["name"].as_str() == Some(name.as_str())).is_none();
                let up_dir = PathBuf::from(up["dir"].as_str().unwrap_or(""));
                let hash = skill_dir_hash(&up_dir);
                if hash == meta["hash"].as_str().unwrap_or("") {
                    results.push(json!({ "name": name, "status": "unchanged", "hash": hash }));
                    continue;
                }
                let target = repo_dir_of(&st).join(name);
                rm_force(&target);
                copy_dir_dereference(&up_dir, &target)?;
                let _ = mutate_store(|s| {
                    let mut entry = meta.clone();
                    entry["hash"] = json!(hash);
                    entry["updatedAt"] = json!(now_iso());
                    entry["skillPath"] = json!(up_dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default());
                    s["remoteRepo"]["skills"][json_pointer_escape(name)] = entry;
                    Ok(Value::Null)
                });
                let mut row = json!({ "name": name, "status": "updated", "hash": hash, "from": meta["hash"] });
                if relocated {
                    row["relocated"] = json!(true);
                }
                results.push(row);
            }
            Ok(())
        })();
        if let Err(e) = outcome {
            results.push(json!({ "name": spec, "status": "error", "error": e.message }));
        }
        if let Some(s) = staging {
            rm_force(&s);
        }
    }
    Ok(json!({ "status": "ok", "results": results }))
}

/// 从远程订阅仓库移除（只动仓库里的条目 + 元数据）。
pub fn remove_from_remote(names: &[String]) -> Res<Value> {
    if names.is_empty() {
        return Err(bad_input("用法: nx-rh-rs skill hub remote remove <name...>"));
    }
    let st = remote_repo_state();
    let dir = repo_dir_of(&st);
    let mut removed: Vec<String> = Vec::new();
    for name in names {
        let in_ledger = st
            .pointer(&format!("/skills/{}", json_pointer_escape(name)))
            .is_some();
        if !in_ledger {
            let exists = std::fs::symlink_metadata(dir.join(name)).is_ok();
            if !exists {
                continue; // 不在 Hub 里就不是错误（幂等）
            }
        }
        rm_force(&dir.join(name));
        let _ = mutate_store(|s| {
            if let Some(obj) = s.pointer_mut("/remoteRepo/skills").and_then(|o| o.as_object_mut()) {
                obj.remove(name);
            }
            Ok(Value::Null)
        });
        removed.push(name.clone());
    }
    Ok(json!({ "dir": dir.to_string_lossy().replace('/', "\\"), "removed": removed }))
}

/// 同步「远程订阅仓库」的元数据：磁盘上的实体被删 / 变成链接时跟着改。
pub fn sync_remote_meta(name: &str, mode: &str) {
    if name.is_empty() {
        return;
    }
    let st = remote_repo_state();
    if st
        .pointer(&format!("/skills/{}", json_pointer_escape(name)))
        .is_none()
    {
        return;
    }
    let _ = mutate_store(|s| {
        match mode {
            "removed" => {
                if let Some(obj) = s.pointer_mut("/remoteRepo/skills").and_then(|o| o.as_object_mut()) {
                    obj.remove(name);
                }
            }
            "linked" => {
                let key = json_pointer_escape(name);
                s["remoteRepo"]["skills"][&key]["spec"] = json!("");
                s["remoteRepo"]["skills"][&key]["url"] = json!("");
                s["remoteRepo"]["skills"][&key]["ref"] = json!("");
            }
            _ => {}
        }
        Ok(Value::Null)
    });
}

/// submit 落入远程订阅仓库时的台账登记。
pub fn upsert_remote_submit_meta(name: &str, from_dir: &str) -> Res<()> {
    let dir = ensure_remote()?;
    let info = read_skill(&Path::new(&dir).join(name));
    let hash = skill_dir_hash(&Path::new(&dir).join(name));
    let stamp = now_iso();
    mutate_store(|s| {
        s["remoteRepo"]["dir"] = json!(dir);
        let key = json_pointer_escape(name);
        let prev = s
            .pointer(&format!("/remoteRepo/skills/{}", key))
            .cloned()
            .unwrap_or(json!({}));
        s["remoteRepo"]["skills"][&key] = json!({
            "name": name,
            "description": info.as_ref().map(|i| i["description"].clone()).unwrap_or(json!("")),
            "hash": hash,
            "spec": prev["spec"].as_str().unwrap_or(""),
            "url": prev["url"].as_str().unwrap_or(""),
            "ref": prev["ref"].as_str().unwrap_or(""),
            "skillPath": name,
            "importedAt": prev["importedAt"].as_str().unwrap_or(&stamp),
            "updatedAt": stamp,
            "submittedFrom": from_dir,
        });
        Ok(Value::Null)
    })?;
    Ok(())
}
