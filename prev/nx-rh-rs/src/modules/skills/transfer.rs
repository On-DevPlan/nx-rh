// 迁移（source → target）与提交（target → source）—— 与 skills/svc/transfer.js 对齐。

use crate::core::paths::CowStrExt;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::core::errors::{bad_input, not_found, Res};
use crate::core::fstree::{copy_dir_dereference, diff_trees, exists, path_exists, rm_force};
use crate::core::link::{create_skill_link, detect_link_type, same_path};
use crate::core::paths::{absolutize, assert_safe_name};
use crate::modules::settings::service::{get_settings, require_hub_path};
use super::entity::place_at;
use super::queries::list_all_skills;
use super::remote_repo::upsert_remote_submit_meta;
use super::scan::resolve_skills_root;
use super::select::{apply_filters, collect_target_skills, name_list, select_source_skills, Filters};
use super::sources::{list_sources, source_entries_for};
use super::targets::resolve_targets;

pub struct MigrateInput<'a> {
    pub names: &'a [String],
    pub all: bool,
    pub all_sources: bool,
    pub include: &'a [String],
    pub exclude: &'a [String],
    pub match_desc: &'a str,
    pub to: &'a str,
    pub platform: &'a str,
    pub mode: &'a str,
    pub project: &'a str,
    pub source: &'a str,
    pub dry_run: bool,
    /// unmigrate 专用：--force（实体副本要显式确认）
    pub force: bool,
}

/// 迁移 skill 到目标集。
pub fn migrate_skill(input: &MigrateInput) -> Res<Value> {
    let s = get_settings();
    let m = if input.mode == "copy" || input.mode == "symlink" {
        input.mode.to_string()
    } else {
        s["skillSyncMode"].as_str().unwrap_or("symlink").to_string()
    };
    let targets = resolve_targets(input.to, input.platform, input.project)?;
    let list = select_source_skills(
        input.names,
        input.all,
        input.all_sources,
        input.include,
        input.exclude,
        input.match_desc,
    )?;

    let mut results: Vec<Value> = Vec::new();
    let mut blocked: Vec<Value> = Vec::new();
    for sk in &list {
        let sk_name = sk["name"].as_str().unwrap_or_default().to_string();
        // 跨源冲突：同名实文件出现在多个订阅源且内容不同
        let entries = source_entries_for(&sk_name)?;
        let mut src = sk.clone();
        let first_md5 = entries.first().and_then(|e| e["md5"].as_str()).unwrap_or("");
        if entries.len() > 1 && entries.iter().any(|e| e["md5"].as_str() != Some(first_md5)) {
            let pick = if !input.source.is_empty() {
                let hit = entries
                    .iter()
                    .find(|e| same_path(e["source"].as_str().unwrap_or(""), input.source));
                if hit.is_none() {
                    return Err(bad_input(format!(
                        "--source 指定的订阅源里没有 {}: {}",
                        sk_name, input.source
                    )));
                }
                hit
            } else {
                None
            };
            let Some(pick) = pick else {
                for t in targets.as_array().cloned().unwrap_or_default() {
                    blocked.push(json!({
                        "name": sk_name,
                        "platform": t["platform"],
                        "platformName": t["platformName"],
                        "scope": t["scope"],
                        "dir": Path::new(t["dir"].as_str().unwrap_or("")).join(&sk_name).to_string_lossy().native(),
                        "status": "blocked",
                        "reason": "同名 skill 在多个订阅源且内容不同",
                        "sources": entries.iter().map(|e| json!({"source": e["source"], "md5": e["md5"]})).collect::<Vec<_>>()
                    }));
                }
                continue;
            };
            src = pick.clone();
        }
        let src_dir = PathBuf::from(src["dir"].as_str().unwrap_or(""));
        for t in targets.as_array().cloned().unwrap_or_default() {
            results.push(place_at(&src_dir, &sk_name, &t, &m, input.dry_run));
        }
    }
    let migrated = results
        .iter()
        .filter(|r| {
            r["status"].as_str() == Some("ok")
                && !r["skipped"].as_bool().unwrap_or(false)
                && !input.dry_run
        })
        .count();
    let would_change = results
        .iter()
        .filter(|r| r["status"].as_str() == Some("ok") && !r["skipped"].as_bool().unwrap_or(false))
        .count();
    let skipped = results.iter().filter(|r| r["skipped"].as_bool().unwrap_or(false)).count();
    let selected: Vec<String> = list
        .iter()
        .map(|x| x["name"].as_str().unwrap_or_default().to_string())
        .collect();
    Ok(json!({
        "status": if !blocked.is_empty() { "blocked" } else { "ok" },
        "dryRun": input.dry_run,
        "mode": m,
        "selected": selected,
        "count": results.len(),
        "migrated": migrated,
        "wouldChange": would_change,
        "skipped": skipped,
        "blocked": blocked,
        "results": results
    }))
}

/// 撤销迁移（target 侧移除）。候选来自目标扫描。
pub fn unmigrate_skill(input: &MigrateInput) -> Res<Value> {
    let targets = resolve_targets(input.to, input.platform, input.project)?;
    let wanted = name_list(&Value::Array(
        input.names.iter().map(|n| json!(n)).collect(),
    ));

    let base: Vec<Value> = if !wanted.is_empty() {
        wanted.iter().map(|n| json!({ "name": n, "description": "" })).collect()
    } else if input.all || !input.include.is_empty() {
        collect_target_skills(input.project)?
    } else {
        return Err(bad_input("需要 <name...>、--all 或 --include <模式> 之一"));
    };
    let list = apply_filters(
        base,
        &Filters {
            include: input.include.to_vec(),
            exclude: input.exclude.to_vec(),
            match_desc: input.match_desc.to_string(),
        },
    );
    if list.is_empty() {
        return Err(not_found("按当前筛选条件没有匹配的 skill"));
    }

    let mut removed: Vec<Value> = Vec::new();
    let mut need_force: Vec<Value> = Vec::new();
    let mut plan: Vec<Value> = Vec::new();
    for item in &list {
        let n = item["name"].as_str().unwrap_or_default().to_string();
        for t in targets.as_array().cloned().unwrap_or_default() {
            let dst = Path::new(t["dir"].as_str().unwrap_or("")).join(&n);
            if !path_exists(&dst) {
                continue;
            }
            let lt = detect_link_type(&dst);
            let entry = json!({
                "name": n,
                "platform": t["platform"],
                "platformName": t["platformName"],
                "scope": t["scope"],
                "path": dst.to_string_lossy().native(),
                "linkType": lt
            });
            if input.dry_run {
                plan.push(entry);
                continue;
            }
            if lt.is_empty() && !input.force {
                need_force.push(entry);
                continue;
            }
            rm_force(&dst);
            removed.push(entry);
        }
    }
    let selected: Vec<String> = list
        .iter()
        .map(|x| x["name"].as_str().unwrap_or_default().to_string())
        .collect();
    if input.dry_run {
        return Ok(json!({
            "status": "ok", "dryRun": true, "selected": selected,
            "removed": [], "plan": plan, "needForce": [], "missing": []
        }));
    }
    if !need_force.is_empty() && removed.is_empty() {
        return Ok(json!({
            "status": "blocked", "dryRun": false, "selected": selected,
            "removed": removed, "needForce": need_force,
            "reason": format!(
                "{} 处是实体副本（可能含本地改动），删除不可逆，加 --force 确认",
                need_force.len()
            ),
            "missing": []
        }));
    }
    Ok(json!({
        "status": "ok", "dryRun": false, "selected": selected,
        "removed": removed, "needForce": need_force, "missing": []
    }))
}

/// 链接 → 实体（物化）。
pub fn materialize_skill(name: &str, to: &str, platform: &str, project: &str) -> Res<Value> {
    let name = assert_safe_name(name, "skill 名称")?;
    let targets = resolve_targets(to, platform, project)?;
    let mut done: Vec<Value> = Vec::new();
    for t in targets.as_array().cloned().unwrap_or_default() {
        let dst = Path::new(t["dir"].as_str().unwrap_or("")).join(&name);
        if !path_exists(&dst) {
            continue;
        }
        let lt = detect_link_type(&dst);
        if lt.is_empty() {
            continue;
        }
        let Ok(target) = std::fs::read_link(&dst) else { continue };
        let abs_t = absolutize(&target).to_string_lossy().to_string();
        rm_force(&dst);
        copy_dir_dereference(Path::new(&abs_t), &dst)?;
        done.push(json!({
            "platform": t["platform"], "scope": t["scope"],
            "path": dst.to_string_lossy().native(), "source": abs_t
        }));
    }
    Ok(json!({ "converted": !done.is_empty(), "results": done }))
}

// ─── 提交（target → source）─────────────────────────────────────────

struct SubmitOpts {
    targets: Value,
    hub_root: String,
    hub_is_remote: bool,
    force: bool,
    keep_target: bool,
    dry_run: bool,
}

fn submit_one(name: &str, opts: &SubmitOpts) -> Res<Value> {
    let name = assert_safe_name(name, "skill 名称")?;

    // 优先挑「实体」形态的来源
    let mut picked: Option<Value> = None;
    for t in opts.targets.as_array().cloned().unwrap_or_default() {
        let dst = Path::new(t["dir"].as_str().unwrap_or("")).join(&name);
        if !path_exists(&dst) {
            continue;
        }
        let lt = detect_link_type(&dst);
        let better = match &picked {
            None => true,
            Some(p) => lt.is_empty() && !p["linkType"].as_str().unwrap_or("").is_empty(),
        };
        if better {
            picked = Some(json!({
                "platform": t["platform"], "platformName": t["platformName"], "scope": t["scope"],
                "path": dst.to_string_lossy().native(), "linkType": lt
            }));
        }
    }
    let Some(picked) = picked else {
        return Ok(json!({ "status": "missing", "name": name, "reason": "目标目录里没有该 skill" }));
    };
    if !picked["linkType"].as_str().unwrap_or("").is_empty() {
        return Ok(json!({
            "status": "skipped", "name": name,
            "reason": "目标已是链接（本就指向某个源），无需提交",
            "target": picked["path"]
        }));
    }

    let dst = Path::new(&opts.hub_root).join(&name);
    let conflict_files: Vec<Value>;
    if exists(&dst) {
        conflict_files = diff_trees(Path::new(picked["path"].as_str().unwrap_or("")), &dst)
            .into_iter()
            .map(|d| json!({ "file": d.file, "side": d.side }))
            .collect();
        if !conflict_files.is_empty() && !opts.force {
            return Ok(json!({
                "status": "conflict", "name": name, "files": conflict_files,
                "path": dst.to_string_lossy().native(), "target": picked["path"]
            }));
        }
    }
    if opts.dry_run {
        return Ok(json!({
            "status": "ok", "name": name, "dryRun": true,
            "sourceDir": dst.to_string_lossy().native(),
            "target": picked["path"],
            "wouldRelink": !opts.keep_target
        }));
    }

    if exists(&dst) {
        rm_force(&dst);
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(crate::core::errors::io_err)?;
    }
    copy_dir_dereference(Path::new(picked["path"].as_str().unwrap_or("")), &dst)?;

    if opts.hub_is_remote {
        upsert_remote_submit_meta(&name, picked["path"].as_str().unwrap_or(""))?;
    }

    let mut relinked: Option<String> = None;
    if !opts.keep_target {
        rm_force(Path::new(picked["path"].as_str().unwrap_or("")));
        let r = create_skill_link(&dst, Path::new(picked["path"].as_str().unwrap_or("")));
        relinked = Some(if r.ok {
            r.link_type.unwrap_or_else(|| "symlink".into())
        } else {
            // 建链失败时至少恢复一份副本
            copy_dir_dereference(&dst, Path::new(picked["path"].as_str().unwrap_or(""))).ok();
            String::new()
        });
    }
    Ok(json!({
        "status": "ok", "name": name,
        "sourceDir": dst.to_string_lossy().native(),
        "target": picked["path"],
        "relinked": relinked,
        "keepTarget": opts.keep_target
    }))
}

pub struct SubmitInput<'a> {
    pub names: &'a [String],
    pub all: bool,
    pub include: &'a [String],
    pub exclude: &'a [String],
    pub match_desc: &'a str,
    pub to: &'a str,
    pub platform: &'a str,
    pub project: &'a str,
    pub force: bool,
    pub keep_target: bool,
    pub dry_run: bool,
    pub into: &'a str,
}

pub fn submit_skill(input: &SubmitInput) -> Res<Value> {
    let sources = list_sources()?;
    let hub: String;
    let mut hub_is_remote = false;
    if !input.into.is_empty() {
        let hits: Vec<Value> = sources["sources"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|x| same_path(x["path"].as_str().unwrap_or(""), input.into))
            .collect();
        let Some(hit) = hits.first() else {
            let all: Vec<String> = sources["sources"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .map(|x| x["path"].as_str().unwrap_or("").to_string())
                .collect();
            return Err(bad_input(format!(
                "--into 不是已订阅的订阅源: {}（已订阅: {}）",
                input.into,
                if all.is_empty() { "无".into() } else { all.join(" , ") }
            )));
        };
        if !hit["exists"].as_bool().unwrap_or(false) {
            return Err(not_found(format!(
                "--into 指定的订阅源目录不存在: {}",
                hit["path"].as_str().unwrap_or("")
            )));
        }
        hub = hit["path"].as_str().unwrap_or("").to_string();
        hub_is_remote = hit.get("remote").map(|r| !r.is_null()).unwrap_or(false);
    } else {
        hub = require_hub_path()?;
    }

    let targets = resolve_targets(input.to, input.platform, input.project)?;
    let hub_root = resolve_skills_root(Path::new(&hub)).to_string_lossy().native();
    let wanted = name_list(&Value::Array(input.names.iter().map(|n| json!(n)).collect()));

    let list: Vec<Value> = if !wanted.is_empty() {
        wanted.iter().map(|n| json!({ "name": n, "description": "" })).collect()
    } else if input.all || !input.include.is_empty() {
        let scan = list_all_skills(input.project, "", "")?;
        scan["orphans"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|o| json!({ "name": o["name"], "description": o["description"].as_str().unwrap_or("") }))
            .collect()
    } else {
        return Err(bad_input("需要 <name...>、--all 或 --include <模式> 之一"));
    };
    let chosen = apply_filters(
        list,
        &Filters {
            include: input.include.to_vec(),
            exclude: input.exclude.to_vec(),
            match_desc: input.match_desc.to_string(),
        },
    );
    if chosen.is_empty() {
        return Err(not_found("按当前筛选条件没有可提交的 skill（都已入 Hub？）"));
    }

    let opts = SubmitOpts {
        targets,
        hub_root,
        hub_is_remote,
        force: input.force,
        keep_target: input.keep_target,
        dry_run: input.dry_run,
    };
    let mut results: Vec<Value> = Vec::new();
    for item in &chosen {
        results.push(submit_one(item["name"].as_str().unwrap_or_default(), &opts)?);
    }
    let conflicts: Vec<Value> = results
        .iter()
        .filter(|r| r["status"].as_str() == Some("conflict"))
        .cloned()
        .collect();
    let submitted = results
        .iter()
        .filter(|r| r["status"].as_str() == Some("ok") && !r["dryRun"].as_bool().unwrap_or(false))
        .count();
    let would_submit = results.iter().filter(|r| r["status"].as_str() == Some("ok")).count();
    let skipped = results.iter().filter(|r| r["status"].as_str() == Some("skipped")).count();
    let missing = results.iter().filter(|r| r["status"].as_str() == Some("missing")).count();
    let selected: Vec<String> = chosen
        .iter()
        .map(|x| x["name"].as_str().unwrap_or_default().to_string())
        .collect();
    Ok(json!({
        "status": if !conflicts.is_empty() { "conflict" } else { "ok" },
        "dryRun": input.dry_run,
        "selected": selected,
        "into": hub,
        "count": results.len(),
        "submitted": submitted,
        "wouldSubmit": would_submit,
        "skipped": skipped,
        "missing": missing,
        "conflicts": conflicts,
        "results": results
    }))
}
