// 环境变量业务层：快照 / dry-run / PATH 条目 / 遮蔽分析 —— 与 env/service.js 对齐。
// 危险逻辑全部落在这里：写前自动快照是每条写路径的必经之路。

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::core::diff::unified_diff;
use crate::core::envvars as driver;
use crate::core::errors::{bad_input, blocked, not_found, Res};
use crate::core::paths::env_snapshot_dir;

pub use driver::{KINDS, SCOPES};

// ─── 纯逻辑：PATH 条目 ────────────────────────────────────────────────

pub fn is_path_name(name: &str) -> bool {
    name.to_lowercase() == "path"
}

/// 空段是噪声，丢弃；非空条目原样保留。
pub fn split_path_entries(value: &str) -> Vec<String> {
    value
        .split(';')
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string())
        .collect()
}

pub fn join_path_entries(entries: &[String]) -> String {
    entries.join(";")
}

/// 条目比较：Windows 大小写不敏感 + 尾随空格。写入时保留原始拼写。
pub fn same_entry(a: &str, b: &str) -> bool {
    a.trim().to_lowercase() == b.trim().to_lowercase()
}

pub struct AddPathResult {
    pub entries: Vec<String>,
    pub added: bool,
    pub existing: String,
}

pub fn add_path_entry(entries: Vec<String>, dir: &str, position: &str) -> Res<AddPathResult> {
    if dir.trim().is_empty() {
        return Err(bad_input("目录不能为空"));
    }
    let hit = entries.iter().find(|e| same_entry(e, dir)).cloned();
    if let Some(hit) = hit {
        return Ok(AddPathResult {
            entries,
            added: false,
            existing: hit,
        });
    }
    let mut next = entries;
    if position == "first" {
        next.insert(0, dir.to_string());
    } else {
        next.push(dir.to_string());
    }
    Ok(AddPathResult { entries: next, added: true, existing: String::new() })
}

#[allow(dead_code)]
pub struct RemovePathResult {
    pub entries: Vec<String>,
    pub removed: usize,
}

pub fn remove_path_entry(entries: Vec<String>, dir: &str) -> RemovePathResult {
    let kept: Vec<String> = entries.into_iter().filter(|e| !same_entry(e, dir)).collect();
    let removed = 0; // 计算在调用处由长度差得出
    let _ = removed;
    RemovePathResult { entries: kept, removed: 0 }
}

// ─── 纯逻辑：值类型决策 ───────────────────────────────────────────────
// 规则 1：绝不降级（已存在的 ExpandString 永远保持）。
// 规则 2：该升级就升级（值里出现 % 时变 ExpandString）。

pub fn decide_kind(existing_kind: &str, value: &str, explicit_kind: &str) -> Res<&'static str> {
    if !explicit_kind.is_empty() {
        let found = KINDS.iter().find(|k| **k == explicit_kind);
        let Some(k) = found else {
            return Err(bad_input(format!("kind 只能是 {} | {}", KINDS[0], KINDS[1])));
        };
        return Ok(k);
    }
    if existing_kind == "ExpandString" {
        return Ok("ExpandString");
    }
    if value.contains('%') {
        return Ok("ExpandString");
    }
    Ok(if KINDS.contains(&existing_kind) { Box::leak(existing_kind.to_string().into_boxed_str()) } else { "String" })
}

/// 结构性编辑（PATH 条目增删）专用：只保留已有类型，不做「含 % 就升级」。
pub fn kind_for_structural_edit(existing_kind: &str) -> &'static str {
    if KINDS.contains(&existing_kind) {
        Box::leak(existing_kind.to_string().into_boxed_str())
    } else {
        "ExpandString"
    }
}

// ─── 纯逻辑：变量名匹配 ───────────────────────────────────────────────

pub fn find_var<'a>(values: &'a [Value], name: &str) -> Option<&'a Value> {
    let key = name.to_lowercase();
    values
        .iter()
        .find(|v| v["name"].as_str().unwrap_or("").to_lowercase() == key)
}

// ─── 纯逻辑：遮蔽分析 ─────────────────────────────────────────────────

pub fn analyze_shadowing(user_values: &[Value], system_values: &[Value]) -> Vec<Value> {
    let mut names: std::collections::BTreeMap<String, String> = std::collections::BTreeMap::new();
    for v in system_values {
        names.insert(v["name"].as_str().unwrap_or("").to_lowercase(), v["name"].as_str().unwrap_or("").to_string());
    }
    for v in user_values {
        names.insert(v["name"].as_str().unwrap_or("").to_lowercase(), v["name"].as_str().unwrap_or("").to_string());
    }

    let mut out: Vec<Value> = Vec::new();
    for (lower, name) in names {
        let u = user_values.iter().find(|v| v["name"].as_str().unwrap_or("").to_lowercase() == lower);
        let s = system_values.iter().find(|v| v["name"].as_str().unwrap_or("").to_lowercase() == lower);
        let both = u.is_some() && s.is_some();
        let is_path = is_path_name(&name);
        let u_val = u.and_then(|v| v["value"].as_str()).unwrap_or("");
        let s_val = s.and_then(|v| v["value"].as_str()).unwrap_or("");
        out.push(json!({
            "name": name,
            "user": u.map(|v| json!({ "value": v["value"], "kind": v["kind"] })).unwrap_or(Value::Null),
            "system": s.map(|v| json!({ "value": v["value"], "kind": v["kind"] })).unwrap_or(Value::Null),
            "scope": if u.is_some() { "user" } else { "system" },
            "shadow": !is_path && both && u_val != s_val,
            "duplicate": both && u_val == s_val,
            "concat": is_path && both,
        }));
    }
    out
}

/// PATH 是唯一的例外：它**不是遮蔽，而是拼接**（系统在前、用户在后）。
pub fn compose_effective_path(system_path: &str, user_path: &str) -> Vec<Value> {
    let system: Vec<Value> = split_path_entries(system_path)
        .into_iter()
        .map(|p| json!({ "path": p, "scope": "system" }))
        .collect();
    let user: Vec<Value> = split_path_entries(user_path)
        .into_iter()
        .map(|p| json!({ "path": p, "scope": "user" }))
        .collect();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out = system;
    out.extend(user);
    out.into_iter()
        .map(|mut e| {
            let key = e["path"].as_str().unwrap_or("").trim().to_lowercase();
            let dup = seen.contains(&key);
            seen.insert(key);
            e["duplicate"] = json!(dup);
            e
        })
        .collect()
}

// ─── 纯逻辑：渲染与 diff ──────────────────────────────────────────────

fn sort_by_name(values: &mut [Value]) {
    values.sort_by(|a, b| {
        a["name"]
            .as_str()
            .unwrap_or("")
            .to_lowercase()
            .cmp(&b["name"].as_str().unwrap_or("").to_lowercase())
    });
}

/// PATH 拆成逐条目的行——否则 diff 里就是一条巨行。
pub fn scope_to_text(values: &[Value]) -> String {
    let mut sorted = values.to_vec();
    sort_by_name(&mut sorted);
    let mut lines: Vec<String> = Vec::new();
    for v in &sorted {
        let name = v["name"].as_str().unwrap_or("");
        if is_path_name(name) {
            lines.push(format!("{} [{}]（PATH 条目）:", name, v["kind"].as_str().unwrap_or("")));
            for (i, e) in split_path_entries(v["value"].as_str().unwrap_or("")).iter().enumerate() {
                lines.push(format!("  {:>3}: {}", i, e));
            }
        } else {
            lines.push(format!(
                "{} [{}] = {}",
                name,
                v["kind"].as_str().unwrap_or(""),
                v["value"].as_str().unwrap_or("")
            ));
        }
    }
    lines.join("\n")
}

fn diff_of(before_all: &Value, after_values: &[Value], scope: &str) -> String {
    let label = if scope == "user" {
        "HKCU\\Environment"
    } else {
        "HKLM\\...\\Session Manager\\Environment"
    };
    let before = before_all[scope]["values"].as_array().cloned().unwrap_or_default();
    unified_diff(
        &scope_to_text(&before),
        &scope_to_text(after_values),
        &format!("{} (当前)", label),
        &format!("{} (写入后)", label),
    )
}

// ─── 快照 ─────────────────────────────────────────────────────────────

const SNAPSHOT_KEEP: usize = 50;

pub fn snapshot_id(now_ms: i64, rand: &str) -> String {
    use chrono::TimeZone;
    let d = chrono::Local.timestamp_opt(now_ms * 1000, 0).single();
    let stamp = match d {
        Some(d) => format!(
            "{}-{}",
            d.format("%Y%m%d%H%M%S"),
            ""
        )
        .trim_end_matches('-')
        .to_string(),
        None => "00000000000000".into(),
    };
    format!("{}-{}", stamp, rand.chars().take(6).collect::<String>())
}

fn snapshot_path(id: &str) -> PathBuf {
    env_snapshot_dir().join(format!("env_{}.json", id))
}

fn write_snapshot(reason: &str, all: &Value) -> Res<Value> {
    use std::sync::atomic::{AtomicU32, Ordering};
    static SEQ: AtomicU32 = AtomicU32::new(0);
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let id = snapshot_id(
        now_ms,
        &format!("{:06x}", (now_ms as u32) ^ seq.wrapping_mul(2654435761)),
    );
    let snap = json!({
        "id": id,
        "createdAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "reason": reason,
        "user": { "values": all["user"]["values"] },
        "system": { "values": all["system"]["values"] },
    });
    std::fs::create_dir_all(env_snapshot_dir()).map_err(crate::core::errors::io_err)?;
    std::fs::write(snapshot_path(&id), serde_json::to_string_pretty(&snap).unwrap_or_default())
        .map_err(crate::core::errors::io_err)?;
    prune_snapshots();
    Ok(snap)
}

fn prune_snapshots() {
    let list = list_snapshots();
    for s in list.iter().skip(SNAPSHOT_KEEP) {
        let _ = std::fs::remove_file(s["file"].as_str().unwrap_or(""));
    }
}

pub fn list_snapshots() -> Vec<Value> {
    let dir = env_snapshot_dir();
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return vec![],
    };
    let mut out: Vec<Value> = Vec::new();
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !name.starts_with("env_") || !name.ends_with(".json") {
            continue;
        }
        let file = dir.join(&name);
        let Ok(text) = std::fs::read_to_string(&file) else { continue };
        let Ok(snap) = serde_json::from_str::<Value>(&text) else { continue };
        out.push(json!({
            "id": snap["id"],
            "createdAt": snap["createdAt"],
            "reason": snap["reason"].as_str().unwrap_or(""),
            "userCount": snap.pointer("/user/values").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0),
            "systemCount": snap.pointer("/system/values").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0),
            "file": file.to_string_lossy(),
        }));
    }
    // 新的在前（文件名时间戳零填充，字典序即时间序）
    out.sort_by(|a, b| {
        b["id"].as_str().unwrap_or("").cmp(a["id"].as_str().unwrap_or(""))
    });
    out
}

pub fn save_snapshot(label: &str) -> Res<Value> {
    let all = driver::read_all()?;
    write_snapshot(if label.is_empty() { "手动快照" } else { label }, &all)
}

fn read_snapshot(id: &str) -> Res<Value> {
    if id.is_empty() {
        return Err(bad_input("快照 id 不能为空"));
    }
    let file = snapshot_path(id);
    std::fs::read_to_string(&file)
        .map_err(|_| not_found(format!("快照不存在: {}（用 nx-rh-rs env snapshot list 查看）", id)))?
        .parse::<Value>()
        .map_err(|e| bad_input(format!("快照损坏: {}", e)))
}

// ─── 编排：读 ─────────────────────────────────────────────────────────

pub fn status() -> Res<Value> {
    let p = driver::probe();
    // user 是「有才有」的字段：JS 版 probe 在不支持的平台返回的对象里根本没有这个键，
    // JSON.stringify 会直接省略。Rust 侧显式跳过，否则 --json 形状会多出 "user": null。
    //
    // reason 刻意**不**往这里搬：JS 的 probe 会给出失败原因，但 status() 只挑
    // supported/elevated/user/writable 四个字段转发，reason 只留在 probe 内部。
    // 早期版本把 reason 也塞进了 status，结果 --json 形状比 JS 多一个键。
    let mut out = serde_json::Map::new();
    out.insert("platform".into(), json!(driver::PLATFORM));
    out.insert("supported".into(), json!(p.supported));
    out.insert("elevated".into(), json!(p.elevated));
    if let Some(u) = &p.user {
        out.insert("user".into(), json!(u));
    }
    out.insert("scopeWritable".into(), json!(p.writable));
    out.insert("snapshotDir".into(), json!(env_snapshot_dir().to_string_lossy()));
    out.insert("note".into(), json!("写入的是注册表里的持久化值，新开的终端/应用会读到；已经启动的进程（含本机已开的终端）不会自动跟变。"));
    Ok(Value::Object(out))
}

pub fn list(scope: &str) -> Res<Value> {
    let all = driver::read_all()?;
    if !scope.is_empty() {
        if !SCOPES.contains(&scope) {
            return Err(bad_input(format!("scope 只能是 user | system，收到: {}", scope)));
        }
        let mut values = all[scope]["values"].as_array().cloned().unwrap_or_default();
        sort_by_name(&mut values);
        return Ok(json!({ "scope": scope, "values": values }));
    }
    let user_values = all["user"]["values"].as_array().cloned().unwrap_or_default();
    let system_values = all["system"]["values"].as_array().cloned().unwrap_or_default();
    let mut user_sorted = user_values.clone();
    let mut system_sorted = system_values.clone();
    sort_by_name(&mut user_sorted);
    sort_by_name(&mut system_sorted);
    let merged = analyze_shadowing(&user_values, &system_values);
    let sys_path = find_var(&system_values, "Path").and_then(|v| v["value"].as_str()).unwrap_or("");
    let user_path = find_var(&user_values, "Path").and_then(|v| v["value"].as_str()).unwrap_or("");
    Ok(json!({
        "scopes": {
            "user": { "writable": true, "values": user_sorted },
            "system": { "values": system_sorted }
        },
        "merged": merged,
        "path": compose_effective_path(sys_path, user_path)
    }))
}

pub fn get(name: &str) -> Res<Value> {
    if name.is_empty() {
        return Err(bad_input("变量名不能为空"));
    }
    let all = driver::read_all()?;
    let user_values = all["user"]["values"].as_array().cloned().unwrap_or_default();
    let system_values = all["system"]["values"].as_array().cloned().unwrap_or_default();
    let u = find_var(&user_values, name);
    let s = find_var(&system_values, name);
    if u.is_none() && s.is_none() {
        return Err(not_found(format!("环境变量不存在: {}", name)));
    }
    let is_path = is_path_name(name);
    let u_val = u.and_then(|v| v["value"].as_str()).unwrap_or("");
    let s_val = s.and_then(|v| v["value"].as_str()).unwrap_or("");
    Ok(json!({
        "name": u.map(|v| v["name"].clone()).or_else(|| s.map(|v| v["name"].clone())).unwrap_or(json!(name)),
        "user": u.map(|v| json!({ "value": v["value"], "kind": v["kind"] })).unwrap_or(Value::Null),
        "system": s.map(|v| json!({ "value": v["value"], "kind": v["kind"] })).unwrap_or(Value::Null),
        "shadow": !is_path && u.is_some() && s.is_some() && u_val != s_val,
        "pathEntries": if is_path { json!(compose_effective_path(s_val, u_val)) } else { Value::Null },
    }))
}

pub fn path_list(scope: &str) -> Res<Value> {
    let all = driver::read_all()?;
    let pick = |s: &str| -> Vec<String> {
        let values = all[s]["values"].as_array().cloned().unwrap_or_default();
        find_var(&values, "Path")
            .and_then(|v| v["value"].as_str())
            .map(split_path_entries)
            .unwrap_or_default()
    };
    if !scope.is_empty() {
        if !SCOPES.contains(&scope) {
            return Err(bad_input(format!("scope 只能是 user | system，收到: {}", scope)));
        }
        return Ok(json!({ "scope": scope, "entries": pick(scope) }));
    }
    Ok(json!({ "user": pick("user"), "system": pick("system") }))
}

// ─── 编排：写（安全网在这里）──────────────────────────────────────────

struct WritePlan {
    status_skipped: Option<Value>,
    blocked_msg: Option<String>,
    values: Vec<Value>,
    writes: Vec<Value>,
}

/// 每条写路径的唯一出口：算目标 → dry-run? → 自动快照 → 落盘 →（广播）。
fn guarded_write(
    reason: &str,
    scope: &str,
    dry_run: bool,
    notify: bool,
    apply: impl FnOnce(&Value) -> Res<WritePlan>,
) -> Res<Value> {
    let before = driver::read_all()?;
    let plan = apply(&before)?;

    if let Some(skipped) = plan.status_skipped {
        return Ok(skipped);
    }
    if let Some(msg) = plan.blocked_msg {
        return Err(blocked(msg));
    }

    let diff = diff_of(&before, &plan.values, scope);

    if dry_run {
        let before_txt = scope_to_text(&before[scope]["values"].as_array().cloned().unwrap_or_default());
        let after_txt = scope_to_text(&plan.values);
        return Ok(json!({
            "dryRun": true, "scope": scope, "reason": reason,
            "changed": before_txt != after_txt,
            "diff": diff,
            "writes": plan.writes
        }));
    }

    let snapshot = write_snapshot(reason, &before)?;

    for w in &plan.writes {
        match w["op"].as_str().unwrap_or("") {
            "set" => {
                driver::write_value(
                    scope,
                    w["name"].as_str().unwrap_or(""),
                    w["value"].as_str().unwrap_or(""),
                    w["kind"].as_str().unwrap_or("String"),
                    notify,
                )?;
            }
            _ => {
                driver::delete_value(scope, w["name"].as_str().unwrap_or(""), notify)?;
            }
        }
    }

    let after = driver::read_all()?;
    Ok(json!({
        "dryRun": false, "scope": scope, "reason": reason,
        "snapshot": snapshot["id"],
        "diff": diff_of(&before, &after[scope]["values"].as_array().cloned().unwrap_or_default().as_slice(), scope),
        "writes": plan.writes
    }))
}

pub fn set_variable(
    name: &str,
    value: &str,
    scope: &str,
    kind: &str,
    dry_run: bool,
    notify: bool,
) -> Res<Value> {
    if name.is_empty() {
        return Err(bad_input("变量名不能为空"));
    }
    if !SCOPES.contains(&scope) {
        return Err(bad_input(format!("scope 只能是 user | system，收到: {}", scope)));
    }
    let scope = scope.to_string();
    let name = name.to_string();
    let value = value.to_string();
    let kind = kind.to_string();
    let reason = format!("env set {} ({})", name, scope);
    let scope_ref = scope.clone();
    guarded_write(&reason, &scope_ref, dry_run, notify, move |all| {
        let values = all[&scope]["values"].as_array().cloned().unwrap_or_default();
        let existing = find_var(&values, &name);
        let existing_kind = existing
            .and_then(|e| e["kind"].as_str())
            .unwrap_or("")
            .to_string();
        let resolved_kind = decide_kind(&existing_kind, &value, &kind)?;
        let final_name = existing
            .and_then(|e| e["name"].as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| name.clone());
        let rest: Vec<Value> = values
            .iter()
            .filter(|v| {
                v["name"].as_str().unwrap_or("").to_lowercase()
                    != final_name.to_lowercase()
            })
            .cloned()
            .collect();
        let mut next = rest;
        next.push(json!({ "name": final_name, "kind": resolved_kind, "value": value }));
        Ok(WritePlan {
            status_skipped: None,
            blocked_msg: None,
            values: next,
            writes: vec![json!({ "op": "set", "name": final_name, "value": value, "kind": resolved_kind })],
        })
    })
}

pub fn remove_variable(name: &str, scope: &str, dry_run: bool, notify: bool) -> Res<Value> {
    if name.is_empty() {
        return Err(bad_input("变量名不能为空"));
    }
    if !SCOPES.contains(&scope) {
        return Err(bad_input(format!("scope 只能是 user | system，收到: {}", scope)));
    }
    let scope = scope.to_string();
    let name = name.to_string();
    let reason = format!("env remove {} ({})", name, scope);
    let scope_ref = scope.clone();
    guarded_write(&reason, &scope_ref, dry_run, notify, move |all| {
        let values = all[&scope]["values"].as_array().cloned().unwrap_or_default();
        let existing = find_var(&values, &name);
        let Some(existing) = existing else {
            return Ok(WritePlan {
                status_skipped: Some(json!({
                    "status": "skipped",
                    "reason": format!("{} 级不存在变量 {}", scope, name)
                })),
                blocked_msg: None,
                values: values,
                writes: vec![],
            });
        };
        let final_name = existing["name"].as_str().unwrap_or("").to_string();
        let next: Vec<Value> = values
            .iter()
            .filter(|v| v["name"].as_str().unwrap_or("").to_lowercase() != name.to_lowercase())
            .cloned()
            .collect();
        Ok(WritePlan {
            status_skipped: None,
            blocked_msg: None,
            values: next,
            writes: vec![json!({ "op": "delete", "name": final_name })],
        })
    })
}

pub fn path_add(dir: &str, scope: &str, position: &str, dry_run: bool, notify: bool) -> Res<Value> {
    if dir.trim().is_empty() {
        return Err(bad_input("目录不能为空"));
    }
    if !SCOPES.contains(&scope) {
        return Err(bad_input(format!("scope 只能是 user | system，收到: {}", scope)));
    }
    let scope = scope.to_string();
    let dir = dir.to_string();
    let position = position.to_string();
    let reason = format!("env path add {} ({})", dir, scope);
    let scope_ref = scope.clone();
    guarded_write(&reason, &scope_ref, dry_run, notify, move |all| {
        let values = all[&scope]["values"].as_array().cloned().unwrap_or_default();
        let existing = find_var(&values, "Path");
        let entries = existing
            .and_then(|e| e["value"].as_str())
            .map(split_path_entries)
            .unwrap_or_default();
        let res = add_path_entry(entries, &dir, &position)?;
        if !res.added {
            return Ok(WritePlan {
                status_skipped: Some(json!({ "status": "skipped", "reason": format!("PATH 中已存在: {}", res.existing) })),
                blocked_msg: None,
                values,
                writes: vec![],
            });
        }
        let value = join_path_entries(&res.entries);
        let kind = kind_for_structural_edit(existing.and_then(|e| e["kind"].as_str()).unwrap_or(""));
        let name = existing
            .and_then(|e| e["name"].as_str())
            .unwrap_or("Path")
            .to_string();
        let mut next: Vec<Value> = values
            .iter()
            .filter(|v| v["name"].as_str().unwrap_or("").to_lowercase() != "path")
            .cloned()
            .collect();
        next.push(json!({ "name": name, "kind": kind, "value": value }));
        Ok(WritePlan {
            status_skipped: None,
            blocked_msg: None,
            values: next,
            writes: vec![json!({ "op": "set", "name": name, "value": value, "kind": kind })],
        })
    })
}

pub fn path_remove(dir: &str, scope: &str, dry_run: bool, notify: bool) -> Res<Value> {
    if dir.trim().is_empty() {
        return Err(bad_input("目录不能为空"));
    }
    if !SCOPES.contains(&scope) {
        return Err(bad_input(format!("scope 只能是 user | system，收到: {}", scope)));
    }
    let scope = scope.to_string();
    let dir = dir.to_string();
    let reason = format!("env path remove {} ({})", dir, scope);
    let scope_ref = scope.clone();
    guarded_write(&reason, &scope_ref, dry_run, notify, move |all| {
        let values = all[&scope]["values"].as_array().cloned().unwrap_or_default();
        let existing = find_var(&values, "Path");
        let Some(existing) = existing else {
            return Ok(WritePlan {
                status_skipped: Some(json!({ "status": "skipped", "reason": format!("{} 级没有 Path", scope) })),
                blocked_msg: None,
                values,
                writes: vec![],
            });
        };
        let raw = existing["value"].as_str().unwrap_or("").to_string();
        let before_len = split_path_entries(&raw).len();
        let res = remove_path_entry(split_path_entries(&raw), &dir);
        let removed = before_len - res.entries.len();
        if removed == 0 {
            return Ok(WritePlan {
                status_skipped: Some(json!({ "status": "skipped", "reason": format!("PATH 中没有: {}", dir) })),
                blocked_msg: None,
                values,
                writes: vec![],
            });
        }
        if res.entries.is_empty() {
            return Ok(WritePlan {
                status_skipped: None,
                blocked_msg: Some("拒绝执行：这会让 PATH 变成空值，命令行将不可用".into()),
                values,
                writes: vec![],
            });
        }
        let value = join_path_entries(&res.entries);
        let kind = kind_for_structural_edit(existing["kind"].as_str().unwrap_or(""));
        let name = existing["name"].as_str().unwrap_or("Path").to_string();
        let mut next: Vec<Value> = values
            .iter()
            .filter(|v| v["name"].as_str().unwrap_or("").to_lowercase() != "path")
            .cloned()
            .collect();
        next.push(json!({ "name": name, "kind": kind, "value": value }));
        Ok(WritePlan {
            status_skipped: None,
            blocked_msg: None,
            values: next,
            writes: vec![json!({ "op": "set", "name": name, "value": value, "kind": kind })],
        })
    })
}

// ─── 编排：恢复快照 ───────────────────────────────────────────────────

pub fn restore_snapshot(id: &str, dry_run: bool, notify: bool) -> Res<Value> {
    let snap = read_snapshot(id)?;
    let before = driver::read_all()?;
    let probe = driver::probe();

    let mut plans: Vec<(String, Vec<Value>)> = Vec::new();
    let mut skipped_scopes: Vec<String> = Vec::new();
    for scope in SCOPES {
        let Some(target) = snap[scope]["values"].as_array().cloned() else {
            continue;
        };
        let writable = match scope {
            "user" => probe.writable.user,
            _ => probe.writable.system,
        };
        if !writable {
            skipped_scopes.push(scope.to_string());
            continue;
        }
        plans.push((scope.to_string(), target));
    }

    if plans.is_empty() {
        return Err(blocked(
            "没有可恢复的 scope：系统级恢复需要以管理员身份运行 nx-rh-rs，而快照里也没有用户级数据",
        ));
    }

    let diff = plans
        .iter()
        .map(|(scope, values)| diff_of(&before, values, scope))
        .collect::<Vec<_>>()
        .join("\n\n");

    if dry_run {
        let scopes: Vec<String> = plans.iter().map(|(s, _)| s.clone()).collect();
        return Ok(json!({
            "dryRun": true, "id": id, "diff": diff,
            "scopes": scopes, "skippedScopes": skipped_scopes
        }));
    }

    // 恢复本身也是写操作 → 先自动快照
    let guard = write_snapshot(&format!("env snapshot restore {}（恢复前自动备份）", id), &before)?;

    for (scope, values) in &plans {
        let target_names: std::collections::HashSet<String> = values
            .iter()
            .map(|v| v["name"].as_str().unwrap_or("").to_lowercase())
            .collect();
        let mut writes: Vec<Value> = Vec::new();
        let cur = before[scope]["values"].as_array().cloned().unwrap_or_default();
        for c in &cur {
            if !target_names.contains(&c["name"].as_str().unwrap_or("").to_lowercase()) {
                writes.push(json!({ "op": "delete", "name": c["name"] }));
            }
        }
        for v in values {
            writes.push(json!({
                "op": "set", "name": v["name"], "value": v["value"], "kind": v["kind"]
            }));
        }
        for w in &writes {
            match w["op"].as_str().unwrap_or("") {
            "set" => {
                driver::write_value(
                    scope,
                    w["name"].as_str().unwrap_or(""),
                    w["value"].as_str().unwrap_or(""),
                    w["kind"].as_str().unwrap_or("String"),
                    notify,
                )?;
            }
            _ => {
                driver::delete_value(scope, w["name"].as_str().unwrap_or(""), notify)?;
            }
            }
        }
    }

    let after = driver::read_all()?;
    let restored: Vec<String> = plans.iter().map(|(s, _)| s.clone()).collect();
    let final_diff = plans
        .iter()
        .map(|(scope, _)| {
            let after_values = after[scope]["values"].as_array().cloned().unwrap_or_default();
            diff_of(&before, &after_values, scope)
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    Ok(json!({
        "dryRun": false,
        "status": if skipped_scopes.is_empty() { "ok" } else { "partial" },
        "id": id,
        "restored": restored,
        "skippedScopes": skipped_scopes,
        "snapshot": guard["id"],
        "diff": final_diff
    }))
}

use serde_json::Value as V;
#[allow(unused_imports)]
use V as _V;

// Path 引用防未用
#[allow(dead_code)]
fn _touch(p: &Path) {
    let _ = p.to_path_buf();
}
