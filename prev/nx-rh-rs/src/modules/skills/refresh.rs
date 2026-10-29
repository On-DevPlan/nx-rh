// skill hub refresh / search —— 与 skills/svc/refresh.js + search.js 对齐。

use std::path::Path;

use serde_json::{json, Value};

use crate::core::errors::{bad_input, external, Res};
use crate::core::store::{load_store, mutate_store};
use super::scan::{resolve_skills_root, scan_skills_root, skill_dir_hash};
use super::sources::list_sources;

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// refresh [source]：重新扫描并与上次快照对比。
pub fn refresh_sources(input: &str, dry_run: bool) -> Res<Value> {
    let listing = list_sources()?;
    let sources = listing["sources"].as_array().cloned().unwrap_or_default();
    if sources.is_empty() {
        return Ok(json!({
            "status": "ok", "results": [],
            "note": "没有订阅源（先 skill hub subscribe <路径>）"
        }));
    }
    let targets: Vec<Value> = if !input.is_empty() {
        let low = input.to_lowercase();
        let abs = crate::core::paths::absolutize(Path::new(input))
            .to_string_lossy()
            .to_lowercase();
        let hit: Vec<Value> = sources
            .iter()
            .filter(|s| {
                let p = s["path"].as_str().unwrap_or("").to_lowercase();
                p == abs || p.contains(&low)
            })
            .cloned()
            .collect();
        if hit.is_empty() {
            return Err(bad_input(format!("找不到订阅源: {}", input)));
        }
        hit
    } else {
        sources
    };

    let st = load_store();
    let mut results: Vec<Value> = Vec::new();
    for s in &targets {
        let path = s["path"].as_str().unwrap_or("").to_string();
        if !s["exists"].as_bool().unwrap_or(false) {
            results.push(json!({ "source": path, "error": "目录不存在" }));
            continue;
        }
        let before: Value = st
            .pointer(&format!(
                "/sourceSnapshots/{}",
                super::remote_repo::json_pointer_escape(&path)
            ))
            .cloned()
            .unwrap_or(json!({}));
        let before_skills = before["skills"].clone();
        let is_remote = s.get("remote").map(|r| !r.is_null()).unwrap_or(false);

        let root = resolve_skills_root(Path::new(s["path"].as_str().unwrap_or("")));
        let skills = scan_skills_root(&root, None, true);
        let mut snap = serde_json::Map::new();
        for sk in &skills {
            let name = sk["name"].as_str().unwrap_or_default().to_string();
            snap.insert(name.clone(), json!(skill_dir_hash(&root.join(&name))));
        }
        let snap_val = Value::Object(snap.clone());

        // 首次没有基准：远程订阅仓库另有台账可当首次基准
        let mut base = before_skills.clone();
        let base_empty = base.as_object().map(|o| o.is_empty()).unwrap_or(true);
        if base_empty && is_remote {
            let repo = st["remoteRepo"].clone();
            let mut known = serde_json::Map::new();
            if let Some(obj) = repo["skills"].as_object() {
                for (name, meta) in obj {
                    if let Some(hash) = meta["hash"].as_str() {
                        known.insert(name.clone(), json!(hash));
                    }
                }
            }
            if !known.is_empty() {
                base = Value::Object(known);
            }
        }

        // diff
        let mut added: Vec<String> = Vec::new();
        let mut removed: Vec<String> = Vec::new();
        let mut changed: Vec<String> = Vec::new();
        let base_obj = base.as_object().cloned().unwrap_or_default();
        for (name, hash) in &snap {
            match base_obj.get(name).and_then(|h| h.as_str()) {
                None => added.push(name.clone()),
                Some(prev) if prev != hash.as_str().unwrap_or("") => changed.push(name.clone()),
                _ => {}
            }
        }
        for name in base_obj.keys() {
            if !snap.contains_key(name) {
                removed.push(name.clone());
            }
        }
        added.sort();
        removed.sort();
        changed.sort();
        let clean = added.is_empty() && removed.is_empty() && changed.is_empty();

        if is_remote {
            // 远程订阅仓库：refresh 顺带把台账指纹与磁盘对齐
            mutate_store(|store| {
                for name in &changed {
                    let key = super::remote_repo::json_pointer_escape(name);
                    if store.pointer(&format!("/remoteRepo/skills/{}", key)).is_some() {
                        store["remoteRepo"]["skills"][&key]["hash"] = snap[name].clone();
                    }
                }
                for name in &added {
                    let key = super::remote_repo::json_pointer_escape(name);
                    if store.pointer(&format!("/remoteRepo/skills/{}", key)).is_none() {
                        store["remoteRepo"]["skills"][&key] = json!({
                            "name": name, "description": "", "hash": snap[name],
                            "spec": "", "url": "", "ref": "", "skillPath": name,
                            "importedAt": now_iso(), "updatedAt": now_iso(),
                        });
                    }
                }
                for name in &removed {
                    if let Some(obj) = store.pointer_mut("/remoteRepo/skills").and_then(|o| o.as_object_mut()) {
                        obj.remove(name);
                    }
                }
                Ok(Value::Null)
            })?;
        }

        if !dry_run {
            mutate_store(|store| {
                store["sourceSnapshots"][super::remote_repo::json_pointer_escape(&path)] = json!({
                    "skills": snap_val, "scannedAt": now_iso()
                });
                Ok(Value::Null)
            })?;
        }
        let base_was_empty = base_empty;
        let mut row = json!({
            "source": path,
            "remote": is_remote,
            "clean": clean,
        });
        if is_remote {
            row["aligned"] = json!(changed.len());
        } else {
            row["added"] = json!(added);
            row["removed"] = json!(removed);
            row["changed"] = json!(changed);
            row["firstTime"] = json!(base_was_empty);
        }
        results.push(row);
    }
    Ok(json!({ "status": "ok", "results": results, "dryRun": dry_run }))
}

// ─── skill hub search（skills.sh 注册表）─────────────────────────────

const DEFAULT_BASE: &str = "https://skills.sh";
const DEFAULT_LIMIT: usize = 20;

/// 剥终端控制序列与 C0/C1 控制字符（CWE-150 防御）。
pub fn sanitize_meta(text: &str) -> String {
    let mut out = String::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            // OSC / DCS / APC / PM：吞到 ST(BEL 或 ESC\)
            let mut peeked = String::new();
            while let Some(&n) = chars.peek() {
                peeked.push(n);
                chars.next();
                if n == '\x07' {
                    peeked.clear();
                    break;
                }
                if n == '\\' && peeked.ends_with('\x1b') {
                    peeked.clear();
                    break;
                }
                if peeked.len() > 128 {
                    break; // 不像转义序列，按 SIMPLE_ESC 丢这一个 ESC 即可
                }
            }
            continue;
        }
        if (c as u32) < 0x20 && c != '\t' && c != '\n' {
            continue; // C0
        }
        if ('\u{80}'..='\u{9f}').contains(&c) {
            continue; // C1
        }
        out.push(c);
    }
    out.replace("\r", " ").replace('\n', " ").trim().chars().take(300).collect()
}

fn search_base() -> String {
    std::env::var("NX_RH_SKILLS_SH_URL")
        .unwrap_or_else(|_| DEFAULT_BASE.to_string())
        .trim_end_matches('/')
        .to_string()
}

fn is_github_owner(owner: &str) -> bool {
    let bytes = owner.as_bytes();
    if bytes.is_empty() || bytes.len() > 39 {
        return false;
    }
    bytes[0].is_ascii_alphanumeric()
        && bytes.iter().all(|b| b.is_ascii_alphanumeric() || *b == b'-')
}

/// 搜 skills.sh 注册表。网络/HTTP 错误抛 EXTERNAL；结果按 installs 降序。
pub fn search_registry(query: &str, owner: &str, limit: &str) -> Res<Value> {
    let q = query.trim();
    if q.is_empty() {
        return Err(bad_input("用法: nx-rh-rs skill hub search <关键词> [--owner <o>]"));
    }
    if q.chars().count() < 2 {
        return Err(bad_input("关键词至少 2 个字符（过短的关键词注册表不受理）"));
    }
    if !owner.is_empty() && !is_github_owner(owner) {
        return Err(bad_input(format!("--owner 必须是合法的 GitHub 组织/用户名: {}", owner)));
    }
    let cap = limit
        .parse::<usize>()
        .ok()
        .filter(|n| *n > 0)
        .map(|n| n.min(50))
        .unwrap_or(DEFAULT_LIMIT);

    let mut url = format!("{}{}api/search?q={}&limit={}", search_base(), "/api/search", urlencode(q), cap);
    if !owner.is_empty() {
        url.push_str(&format!("&owner={}", urlencode(owner)));
    }
    let tmp = std::env::temp_dir().join(format!(
        "nx-rh-rs-search-{:x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    let out = std::process::Command::new("curl")
        .args(["-sS", "--max-time", "15", "-H", "accept: application/json", "-o"])
        .arg(&tmp)
        .arg("-w")
        .arg("%{http_code}")
        .arg(&url)
        .output();
    let Ok(out) = out else {
        return Err(external(format!("搜索请求失败（{}）: curl 不可用", search_base())));
    };
    let code = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if code != "200" {
        let _ = std::fs::remove_file(&tmp);
        if code == "0" {
            return Err(external(format!(
                "搜索请求失败（{}）: {}",
                search_base(),
                String::from_utf8_lossy(&out.stderr).chars().take(200).collect::<String>()
            )));
        }
        return Err(external(format!(
            "注册表返回 HTTP {}（{}）",
            code,
            url.chars().take(120).collect::<String>()
        )));
    }
    let body = std::fs::read_to_string(&tmp).unwrap_or_default();
    let _ = std::fs::remove_file(&tmp);
    let data: Value = serde_json::from_str(&body)
        .map_err(|_| external(format!("注册表返回了无法解析的内容（{}）", search_base())))?;

    let rows = data["skills"].as_array().cloned().unwrap_or_default();
    let mut results: Vec<Value> = rows
        .into_iter()
        .map(|s| {
            json!({
                "name": sanitize_meta(s["name"].as_str().unwrap_or("")),
                "slug": sanitize_meta(s["id"].as_str().unwrap_or("")),
                "source": sanitize_meta(s["source"].as_str().unwrap_or("")),
                "installs": s["installs"].as_u64().unwrap_or(0),
            })
        })
        .filter(|r| !r["name"].as_str().unwrap_or("").is_empty() && !r["source"].as_str().unwrap_or("").is_empty())
        .collect();
    results.sort_by(|a, b| b["installs"].as_u64().unwrap_or(0).cmp(&a["installs"].as_u64().unwrap_or(0)));
    Ok(json!({
        "status": "ok", "query": q, "owner": owner, "base": search_base(),
        "results": results
    }))
}

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}
