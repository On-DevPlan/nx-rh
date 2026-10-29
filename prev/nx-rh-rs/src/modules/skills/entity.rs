// skill 实体的增改删（只动订阅源里那份实文件）—— 与 skills/svc/entity.js 对齐。

use crate::core::paths::CowStrExt;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::core::errors::{bad_input, conflict, not_found, Res};
use crate::core::fstree::{copy_dir_dereference, exists, path_exists, rm_force};
use crate::core::frontmatter::parse_frontmatter;
use crate::core::link::{create_skill_link, detect_link_type, same_path, same_real_path};
use crate::core::paths::{absolutize, assert_safe_name};
use crate::modules::settings::service::{hub_path, require_hub_path};
use super::queries::source_audit;
use super::remote_repo::sync_remote_meta;
use super::scan::resolve_skills_root;
use super::sources::source_entries_for;
use super::targets::resolve_targets;

/// 组装 SKILL.md：frontmatter（name/description）+ 正文。
fn build_skill_md(name: &str, description: &str, body: &str) -> String {
    let desc: String = {
        let d = description.replace("\r\n", " ").replace('\n', " ").trim().to_string();
        if d.is_empty() {
            format!("{} 的说明", name)
        } else {
            d
        }
    };
    let text = body.trim_start();
    let newline = if text.ends_with('\n') { "" } else { "\n" };
    format!("---\nname: {}\ndescription: {}\n---\n\n{}{}", name, desc, text, newline)
}

/// 新建：订阅源里已存在同名 → CONFLICT。
pub fn add_skill(name: &str, description: &str, content: &str) -> Res<Value> {
    let name = assert_safe_name(name, "skill 名称")?;
    let hub = require_hub_path()?;
    let root = resolve_skills_root(Path::new(&hub));
    let dir = root.join(&name);
    if exists(&dir) {
        return Err(conflict(format!("订阅源里已存在同名 skill: {}", dir.display())));
    }
    let raw = content.trim().to_string();
    let md = if raw.starts_with("---") {
        let normalized = if raw.ends_with('\n') { raw.clone() } else { format!("{}\n", raw) };
        let fm = parse_frontmatter(&normalized);
        if fm.name.is_empty() || fm.description.is_empty() {
            return Err(bad_input("SKILL.md 需要含 name 与 description 的 frontmatter"));
        }
        if fm.name != name {
            return Err(bad_input(format!(
                "frontmatter 的 name（{}）必须与目录名一致: {}",
                fm.name, name
            )));
        }
        format!("{}\n", raw)
    } else {
        build_skill_md(&name, description, content)
    };
    std::fs::create_dir_all(&dir).map_err(crate::core::errors::io_err)?;
    std::fs::write(dir.join("SKILL.md"), md).map_err(crate::core::errors::io_err)?;
    let md_path = dir.join("SKILL.md");
    Ok(json!({
        "status": "ok", "name": name,
        "dir": dir.to_string_lossy().native(),
        "path": md_path.to_string_lossy().native()
    }))
}

/// 改写：PATCH 语义——改 SKILL.md 全文。
pub fn update_skill(name: &str, content: &str) -> Res<Value> {
    let name = assert_safe_name(name, "skill 名称")?;
    let entries = source_entries_for(&name)?;
    let current = hub_path();
    let found = entries
        .iter()
        .find(|e| e["source"].as_str() == Some(&current))
        .or_else(|| entries.first());
    let Some(found) = found else {
        return Err(not_found(format!("订阅源里没有该 skill: {}", name)));
    };
    let fm = parse_frontmatter(content);
    if fm.name.is_empty() || fm.description.is_empty() {
        return Err(bad_input(
            "SKILL.md 需要含 name 与 description 的 frontmatter（保留开头三行）",
        ));
    }
    if fm.name != name {
        return Err(bad_input(format!(
            "frontmatter 的 name（{}）必须与目录名一致: {}",
            fm.name, name
        )));
    }
    let dir = PathBuf::from(found["dir"].as_str().unwrap_or(""));
    std::fs::write(dir.join("SKILL.md"), content).map_err(crate::core::errors::io_err)?;
    Ok(json!({
        "status": "ok", "name": name,
        "dir": dir.to_string_lossy().native(),
        "source": found["source"]
    }))
}

/// 删除：目标侧还有副本/链接时先 blocked，--force 才继续。
pub fn remove_skill(name: &str, force: bool, project: &str) -> Res<Value> {
    let name = assert_safe_name(name, "skill 名称")?;
    let entries = source_entries_for(&name)?;
    let current = hub_path();
    let found = entries
        .iter()
        .find(|e| e["source"].as_str() == Some(&current))
        .or_else(|| entries.first());
    let Some(found) = found else {
        return Err(not_found(format!("订阅源里没有该 skill: {}", name)));
    };

    let targets = resolve_targets("all", "", project)?;
    let mut refs: Vec<Value> = Vec::new();
    for t in targets.as_array().cloned().unwrap_or_default() {
        let p = Path::new(t["dir"].as_str().unwrap_or("")).join(&name);
        if path_exists(&p) {
            refs.push(json!({
                "platform": t["platform"],
                "platformName": t["platformName"],
                "scope": t["scope"],
                "path": p.to_string_lossy().native(),
                "linkType": detect_link_type(&p),
            }));
        }
    }
    if !refs.is_empty() && !force {
        return Ok(json!({
            "status": "blocked", "name": name, "refs": refs,
            "reason": format!("{} 个目标还引用着它，删除会让链接悬空", refs.len())
        }));
    }
    rm_force(Path::new(found["dir"].as_str().unwrap_or("")));
    sync_remote_meta(&name, "removed");
    Ok(json!({ "status": "ok", "name": name, "removed": found["dir"], "dangling": refs }))
}

/// 彻底删除一个 skill：所有平台安装位置 + 订阅源里的实文件。
pub fn purge_skill(name: &str, project: &str, force: bool, dry_run: bool) -> Res<Value> {
    let name = assert_safe_name(name, "skill 名称")?;
    let entries = source_entries_for(&name)?;
    let sources: Vec<Value> = entries
        .iter()
        .map(|e| json!({ "source": e["source"], "dir": e["dir"] }))
        .collect();
    let mut targets: Vec<Value> = Vec::new();
    for t in resolve_targets("all", "", project)?.as_array().cloned().unwrap_or_default() {
        let p = Path::new(t["dir"].as_str().unwrap_or("")).join(&name);
        if !path_exists(&p) {
            continue;
        }
        targets.push(json!({
            "platform": t["platform"],
            "platformName": t["platformName"],
            "scope": t["scope"],
            "path": p.to_string_lossy().native(),
            "linkType": detect_link_type(&p),
        }));
    }
    if sources.is_empty() && targets.is_empty() {
        return Err(not_found(format!(
            "未找到 skill: {}（订阅源与各平台目录里都没有）",
            name
        )));
    }
    let copies = targets
        .iter()
        .filter(|c| c["linkType"].as_str().unwrap_or("").is_empty())
        .count();
    let plan = json!({ "name": name, "sources": sources, "targets": targets, "copies": copies });
    if dry_run {
        return Ok(json!({ "status": "ok", "dryRun": true, "name": name, "plan": plan, "removed": [] }));
    }
    if copies > 0 && !force {
        return Ok(json!({
            "status": "blocked", "dryRun": false, "name": name,
            "plan": plan, "removed": [],
            "reason": format!("{} 处是实体副本（可能含本地改动），删除不可逆，加 --force 确认", copies)
        }));
    }

    let mut removed: Vec<Value> = Vec::new();
    // 先删安装位置再删订阅源：反过来链接会先悬空
    for c in targets.iter().cloned().collect::<Vec<_>>() {
        rm_force(Path::new(c["path"].as_str().unwrap_or("")));
        let mut row = c;
        row["kind"] = json!("target");
        removed.push(row);
    }
    for s in sources {
        rm_force(Path::new(s["dir"].as_str().unwrap_or("")));
        removed.push(json!({ "kind": "source", "path": s["dir"], "source": s["source"] }));
    }
    sync_remote_meta(&name, "removed");
    Ok(json!({ "status": "ok", "dryRun": false, "name": name, "plan": plan, "removed": removed }))
}

/// 批量彻底删除：单条的「未找到 / 阻塞」不挡其余。
pub fn purge_skills(names: &[String], project: &str, force: bool, dry_run: bool) -> Res<Value> {
    let list: Vec<String> = names.iter().map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).collect();
    if list.is_empty() {
        return Err(bad_input("缺少要删除的 skill 名（<name...>）"));
    }
    let mut results: Vec<Value> = Vec::new();
    for name in &list {
        match purge_skill(name, project, force, dry_run) {
            Ok(r) => results.push(r),
            Err(e) => results.push(json!({
                "status": "error", "name": name,
                "plan": { "name": name, "sources": [], "targets": [], "copies": 0 },
                "removed": [], "reason": e.message
            })),
        }
    }
    let all_ok = results.iter().all(|r| r["status"].as_str() == Some("ok"));
    let purged = results
        .iter()
        .filter(|r| r["status"].as_str() == Some("ok") && !r["dryRun"].as_bool().unwrap_or(false))
        .count();
    let copies: u64 = results
        .iter()
        .map(|r| r.pointer("/plan/copies").and_then(|c| c.as_u64()).unwrap_or(0))
        .sum();
    Ok(json!({
        "status": if all_ok { "ok" } else { "partial" },
        "dryRun": dry_run,
        "results": results,
        "purged": purged,
        "copies": copies
    }))
}

/// 执行一组唯一化：其余实文件删除 → 按要求原位重建为指向准份的链接。
fn apply_dedupe_group(winner_dir: &Path, others: &[Value], as_mode: &str) -> (Vec<Value>, Vec<Value>, Vec<Value>) {
    let mut removed: Vec<Value> = Vec::new();
    let mut linked: Vec<Value> = Vec::new();
    let mut skipped: Vec<Value> = Vec::new();
    for o in others {
        let o_dir = PathBuf::from(o["dir"].as_str().unwrap_or(""));
        if same_real_path(o["dir"].as_str().unwrap_or(""), &winner_dir.to_string_lossy()) {
            let mut row = o.clone();
            row["reason"] = json!("与准份同一实体");
            skipped.push(row);
            continue;
        }
        rm_force(&o_dir);
        if as_mode == "delete" {
            removed.push(o.clone());
            let _ = super::remote_repo::sync_remote_meta(
                o_dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default().as_str(),
                "removed",
            );
            continue;
        }
        let r = create_skill_link(winner_dir, &o_dir);
        if r.ok {
            let mut row = o.clone();
            row["linkType"] = json!(r.link_type.clone().unwrap_or_default());
            linked.push(row);
            let _ = super::remote_repo::sync_remote_meta(
                o_dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default().as_str(),
                "linked",
            );
        } else {
            copy_dir_dereference(winner_dir, &o_dir).ok();
            let mut row = o.clone();
            row["degraded"] = json!(true);
            row["reason"] = json!(r.error.unwrap_or_default());
            removed.push(row);
        }
    }
    (removed, linked, skipped)
}

/// 唯一化一个跨源重复/冲突的 skill。
pub fn dedupe_skill(name: &str, source: &str, as_mode: &str, force: bool, dry_run: bool) -> Res<Value> {
    let name = assert_safe_name(name, "skill 名称")?;
    if as_mode != "link" && as_mode != "delete" {
        return Err(bad_input("as 只能是 link | delete"));
    }
    let entries = source_entries_for(&name)?;
    let winner = entries.iter().find(|e| same_path(e["source"].as_str().unwrap_or(""), source));
    let Some(winner) = winner else {
        return Err(not_found(format!(
            "--source 指定的订阅源里没有实文件 {}: {}（实文件来源: {}）",
            name,
            source,
            entries
                .iter()
                .map(|e| e["source"].as_str().unwrap_or(""))
                .collect::<Vec<_>>()
                .join(" , ")
        )));
    };
    let others: Vec<Value> = entries
        .iter()
        .filter(|e| e["dir"].as_str() != winner["dir"].as_str())
        .cloned()
        .collect();

    let plan = json!({
        "name": name, "as": as_mode,
        "winner": { "source": winner["source"], "dir": winner["dir"], "md5": winner["md5"] },
        "others": others.iter().map(|e| json!({ "source": e["source"], "dir": e["dir"], "md5": e["md5"] })).collect::<Vec<_>>()
    });
    if others.is_empty() {
        return Ok(json!({
            "status": "ok", "dryRun": dry_run, "name": name, "plan": plan,
            "removed": [], "linked": [],
            "note": "本就只有一份实文件，无需处理"
        }));
    }
    if dry_run {
        return Ok(json!({ "status": "ok", "dryRun": true, "name": name, "plan": plan, "removed": [], "linked": [] }));
    }
    if !force {
        return Ok(json!({
            "status": "blocked", "dryRun": false, "name": name, "plan": plan,
            "removed": [], "linked": [],
            "reason": format!(
                "{} 份非准实文件将{}（可能含本地改动），不可逆，加 --force 确认",
                others.len(),
                if as_mode == "delete" { "被删除" } else { "被链接替换" }
            )
        }));
    }
    let (removed, linked, skipped) =
        apply_dedupe_group(Path::new(winner["dir"].as_str().unwrap_or("")), &others, as_mode);
    Ok(json!({
        "status": "ok", "dryRun": false, "name": name, "plan": plan, "as": as_mode,
        "removed": removed, "linked": linked, "skipped": skipped
    }))
}

/// 批量快捷唯一化：重复/冲突组都以主源实文件为准。
pub fn dedupe_all(names: &[String], as_mode: &str, force: bool, dry_run: bool) -> Res<Value> {
    if as_mode != "link" && as_mode != "delete" {
        return Err(bad_input("as 只能是 link | delete"));
    }
    let want: Vec<String> = names
        .iter()
        .map(|n| assert_safe_name(n, "skill 名称"))
        .collect::<Res<Vec<_>>>()?;
    let audit = source_audit()?;
    let conflicts = audit["conflicts"].as_array().cloned().unwrap_or_default();
    let mut groups: Vec<Value> = Vec::new();
    for c in conflicts {
        let cname = c["name"].as_str().unwrap_or("").to_string();
        if !want.is_empty() && !want.iter().any(|w| *w == cname) {
            continue;
        }
        let entries = c["entries"].as_array().cloned().unwrap_or_default();
        let winner = entries
            .iter()
            .find(|e| e["current"].as_bool().unwrap_or(false))
            .or_else(|| entries.first());
        let Some(winner) = winner else { continue };
        let others: Vec<Value> = entries
            .iter()
            .filter(|e| e["dir"].as_str() != winner["dir"].as_str())
            .map(|e| json!({ "source": e["source"], "dir": e["dir"], "md5": e["md5"] }))
            .collect();
        if others.is_empty() {
            continue;
        }
        groups.push(json!({
            "name": cname,
            "noPrimary": !entries.iter().any(|e| e["current"].as_bool().unwrap_or(false)),
            "winner": { "source": winner["source"], "dir": winner["dir"], "md5": winner["md5"] },
            "others": others
        }));
    }
    let ignored: Vec<String> = want
        .into_iter()
        .filter(|n| !groups.iter().any(|g| g["name"].as_str() == Some(n.as_str())))
        .collect();
    let totals = json!({
        "groups": groups.len(), "linked": 0, "removed": 0, "skipped": 0, "degraded": 0
    });
    if groups.is_empty() {
        return Ok(json!({
            "status": "ok", "dryRun": dry_run, "as": as_mode, "groups": [],
            "ignored": ignored, "totals": totals,
            "note": "没有跨源重复/冲突，无需处理"
        }));
    }
    if dry_run {
        return Ok(json!({ "status": "ok", "dryRun": true, "as": as_mode, "groups": groups, "ignored": ignored, "totals": totals }));
    }
    if !force {
        return Ok(json!({
            "status": "blocked", "dryRun": false, "as": as_mode, "groups": groups,
            "ignored": ignored, "totals": totals,
            "reason": format!(
                "{} 组重复/冲突的非准实文件将{}（可能含本地改动），不可逆，加 --force 确认",
                groups.len(),
                if as_mode == "delete" { "被删除" } else { "被链接替换" }
            )
        }));
    }
    let mut results: Vec<Value> = Vec::new();
    let mut t_linked = 0u64;
    let mut t_removed = 0u64;
    let mut t_skipped = 0u64;
    let mut t_degraded = 0u64;
    for g in &groups {
        let (removed, linked, skipped) = apply_dedupe_group(
            Path::new(g.pointer("/winner/dir").and_then(|d| d.as_str()).unwrap_or("")),
            g["others"].as_array().cloned().unwrap_or_default().as_slice(),
            as_mode,
        );
        t_linked += linked.len() as u64;
        t_removed += removed.len() as u64;
        t_skipped += skipped.len() as u64;
        t_degraded += removed.iter().filter(|x| x["degraded"].as_bool().unwrap_or(false)).count() as u64;
        let mut row = json!({
            "name": g["name"], "noPrimary": g["noPrimary"], "winner": g["winner"],
            "removed": removed, "linked": linked, "skipped": skipped
        });
        row["noPrimary"] = g["noPrimary"].clone();
        results.push(row);
    }
    Ok(json!({
        "status": "ok", "dryRun": false, "as": as_mode, "groups": results,
        "ignored": ignored,
        "totals": { "groups": groups.len(), "linked": t_linked, "removed": t_removed, "skipped": t_skipped, "degraded": t_degraded }
    }))
}

/// 把 srcDir 落到一个目标：已指向同一实体则跳过；其余一律直接覆盖。
pub fn place_at(src_dir: &Path, name: &str, target: &Value, mode: &str, dry_run: bool) -> Value {
    let tdir = target["dir"].as_str().unwrap_or("");
    let dst = Path::new(tdir).join(name);
    let mut base = target.clone();
    base["path"] = json!(dst.to_string_lossy().native());
    let lt = detect_link_type(&dst);
    if !lt.is_empty() {
        if let Ok(t) = std::fs::read_link(&dst) {
            let abs_t = absolutize(&t).to_string_lossy().to_string();
            if same_real_path(&abs_t, &src_dir.to_string_lossy()) {
                let mut row = base;
                row["status"] = json!("ok");
                row["skipped"] = json!(true);
                row["linkType"] = json!(lt);
                return row;
            }
        }
    }
    let existed = exists(&dst);
    if dry_run {
        let mut row = base;
        row["status"] = json!("ok");
        row["mode"] = json!(mode);
        if existed {
            row["wouldReplace"] = json!(true);
        } else {
            row["wouldCreate"] = json!(true);
        }
        return row;
    }

    if mode == "symlink" {
        let r = create_skill_link(src_dir, &dst);
        if r.ok {
            let mut row = base;
            row["status"] = json!("ok");
            row["mode"] = json!("symlink");
            row["linkType"] = json!(r.link_type.unwrap_or_default());
            row["already"] = json!(r.already.unwrap_or(false));
            return row;
        }
        // 链接失败 → 降级复制
        if exists(&dst) {
            rm_force(&dst);
        }
        copy_dir_dereference(src_dir, &dst).ok();
        let mut row = base;
        row["status"] = json!("ok");
        row["mode"] = json!("copy");
        row["degraded"] = json!(true);
        row["degradedReason"] = json!(r.error.unwrap_or_default());
        return row;
    }
    if exists(&dst) {
        rm_force(&dst);
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    copy_dir_dereference(src_dir, &dst).ok();
    let mut row = base;
    row["status"] = json!("ok");
    row["mode"] = json!("copy");
    row
}
