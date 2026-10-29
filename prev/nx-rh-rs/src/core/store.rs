// JSON 存储：用户目录下的单一数据文件 —— 与 core/store.js 对齐。
// - 原子写（临时文件 + rename）
// - 进程内缓存 + mtime 失效检测
// - 读-改-写事务（mutate）

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use once_cell::sync::Lazy;
use serde_json::{json, Value};

use super::errors::Res;
use super::paths::store_path_from_env;

// settings 里按数组维护的键（写入时统一归一化）
pub const ARRAY_SETTINGS: [&str; 3] = ["platforms", "skillHubSources", "skillProjectCandidates"];

fn empty_store() -> Value {
    json!({
        "version": 2,
        "settings": {
            "skillHubPath": "",
            "skillSyncMode": "symlink",
            "platforms": ["claude-code"],
            "defaultPlatform": "claude-code",
            "skillHubSources": [],
            "skillProjectCandidates": []
        },
        "worktreeState": {},
        "recents": [],
        "remoteRepo": { "dir": "", "skills": {} },
        "sourceSnapshots": {}
    })
}

struct Cache {
    data: Option<Value>,
    mtime: i128,
}

static CACHE: Lazy<Mutex<Cache>> = Lazy::new(|| Mutex::new(Cache { data: None, mtime: -1 }));

pub fn new_id(prefix: &str) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    use std::sync::atomic::{AtomicU32, Ordering};
    static SEQ: AtomicU32 = AtomicU32::new(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let mut r = now.subsec_nanos() ^ (seq.wrapping_mul(2654435761));
    let mut tail = String::new();
    for _ in 0..5 {
        tail.push(char_from_base36(r % 36));
        r /= 36;
    }
    format!("{}_{}{}", prefix, to_base36(now.as_secs()), tail)
}

fn char_from_base36(n: u32) -> char {
    std::char::from_u32(if n < 10 { b'0' as u32 + n } else { b'a' as u32 + n - 10 }).unwrap_or('0')
}

fn to_base36(n: u64) -> String {
    let mut out = String::new();
    let mut n = n;
    if n == 0 {
        return "0".into();
    }
    while n > 0 {
        out.insert(0, char_from_base36((n % 36) as u32));
        n /= 36;
    }
    out
}

fn mtime_of(p: &Path) -> i128 {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as i128)
        .unwrap_or(-1)
}

fn is_legacy_remote_source(data: &Value) -> bool {
    data.pointer("/settings/skillHubSources")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .any(|p| {
                    let lower = p.to_lowercase();
                    lower.contains("\\remote-skills\\") || lower.contains("/remote-skills/")
                })
        })
        .unwrap_or(false)
}

fn normalize(data: Option<&Value>) -> Value {
    let mut base = empty_store();
    let Some(data) = data else { return base };
    if !data.is_object() {
        return base;
    }

    base["version"] = data.get("version").cloned().unwrap_or(json!(2));

    // settings：默认值 + 磁盘值合并
    let mut settings = base["settings"].clone();
    if let Some(disk) = data.get("settings").and_then(|v| v.as_object()) {
        for (k, v) in disk {
            settings[k.as_str()] = v.clone();
        }
    }
    // 旧键回填：skillCentralPath / skillCentralCandidates
    if settings["skillHubPath"].as_str().unwrap_or("").is_empty() {
        if let Some(old) = data.pointer("/settings/skillCentralPath").and_then(|v| v.as_str()) {
            settings["skillHubPath"] = json!(old);
        }
    }
    let sources_empty = settings["skillHubSources"]
        .as_array()
        .map(|a| a.is_empty())
        .unwrap_or(true);
    if sources_empty {
        if let Some(legacy) = data.pointer("/settings/skillCentralCandidates").and_then(|v| v.as_array()) {
            if !legacy.is_empty() {
                settings["skillHubSources"] = json!(legacy);
            }
        }
    }
    let _ = settings.as_object_mut().map(|o| {
        o.remove("skillCentralPath");
        o.remove("skillCentralCandidates");
    });
    for key in ARRAY_SETTINGS {
        settings[key] = to_array(&settings[key]);
    }

    // 「每个远程规格各建一个源」的旧模型已废弃：remote-skills 登记自动摘掉
    if let Some(arr) = settings["skillHubSources"].as_array().cloned() {
        let legacy: Vec<String> = arr
            .iter()
            .filter_map(|v| v.as_str())
            .filter(|p| {
                let lower = p.to_lowercase();
                lower.contains("\\remote-skills\\") || lower.contains("/remote-skills/")
            })
            .map(|s| s.to_string())
            .collect();
        if !legacy.is_empty() {
            let kept: Vec<&Value> = arr
                .iter()
                .filter(|v| {
                    v.as_str()
                        .map(|p| {
                            let lower = p.to_lowercase();
                            !(lower.contains("\\remote-skills\\") || lower.contains("/remote-skills/"))
                        })
                        .unwrap_or(true)
                })
                .collect();
            settings["skillHubSources"] = Value::Array(kept.into_iter().cloned().collect());
            let hub = settings["skillHubPath"].as_str().unwrap_or("").to_lowercase();
            if !hub.is_empty() && legacy.iter().any(|p| p.to_lowercase() == hub) {
                settings["skillHubPath"] = json!("");
            }
        }
    }
    base["settings"] = settings;

    base["worktreeState"] = data
        .get("worktreeState")
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or(json!({}));
    base["recents"] = data
        .get("recents")
        .filter(|v| v.is_array())
        .cloned()
        .unwrap_or(json!([]));

    // remoteRepo（键迁移：开发期叫 remoteHub）
    let remote = if let Some(r) = data.get("remoteRepo").filter(|v| v.is_object()) {
        json!({
            "dir": r.get("dir").and_then(|d| d.as_str()).unwrap_or(""),
            "skills": r.get("skills").filter(|s| s.is_object()).cloned().unwrap_or(json!({}))
        })
    } else if let Some(h) = data.get("remoteHub").filter(|v| v.is_object()) {
        if h.get("skills").map(|s| s.is_object()).unwrap_or(false) {
            json!({
                "dir": h.get("dir").and_then(|d| d.as_str()).unwrap_or(""),
                "skills": h["skills"].clone()
            })
        } else {
            json!({ "dir": "", "skills": {} })
        }
    } else {
        json!({ "dir": "", "skills": {} })
    };
    base["remoteRepo"] = remote;

    base["sourceSnapshots"] = data
        .get("sourceSnapshots")
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or(json!({}));

    base
}

fn to_array(v: &Value) -> Value {
    match v {
        Value::Array(arr) => {
            let items: Vec<String> = arr
                .iter()
                .map(|x| x.as_str().unwrap_or_default().trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            json!(items)
        }
        Value::String(s) => {
            let items: Vec<String> = s
                .split(',')
                .map(|x| x.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            json!(items)
        }
        _ => json!([]),
    }
}

pub fn load_store() -> Value {
    load_store_at(None)
}

pub fn load_store_at(explicit: Option<&Path>) -> Value {
    let p = explicit.map(|p| p.to_path_buf()).unwrap_or_else(store_path_from_env);
    let mut cache = CACHE.lock().unwrap();
    let mtime = mtime_of(&p);
    if let (Some(data), Some(m)) = (&cache.data, cache.data.as_ref().map(|_| mtime)) {
        if cache.mtime == m && m >= 0 {
            return data.clone();
        }
    }
    if mtime < 0 {
        cache.data = None;
        cache.mtime = -1;
        return normalize(None);
    }
    let raw = std::fs::read_to_string(&p).unwrap_or_default();
    let parsed: Option<Value> = serde_json::from_str(&raw).ok();
    let had_legacy = parsed.as_ref().map(|d| is_legacy_remote_source(d)).unwrap_or(false);
    let data = normalize(parsed.as_ref());
    cache.data = Some(data.clone());
    cache.mtime = mtime;
    if had_legacy {
        drop(cache);
        save_store_at(&data, explicit);
        let mut cache = CACHE.lock().unwrap();
        cache.data = Some(data.clone());
        cache.mtime = mtime_of(&p);
    }
    data
}

pub fn save_store(next: &Value) -> Value {
    save_store_at(next, None)
}

pub fn save_store_at(next: &Value, explicit: Option<&Path>) -> Value {
    let p: PathBuf = explicit.map(|p| p.to_path_buf()).unwrap_or_else(store_path_from_env);
    let data = normalize(Some(next));
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let tmp = p.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(&data).unwrap_or_default();
    if std::fs::write(&tmp, body).is_ok() {
        // Windows 上 rename 到已存在目标会失败，先删
        let _ = std::fs::remove_file(&p);
        let _ = std::fs::rename(&tmp, &p);
    }
    let mut cache = CACHE.lock().unwrap();
    cache.data = Some(data.clone());
    cache.mtime = mtime_of(&p);
    data
}

/// 读-改-写事务：fn 直接修改深拷贝 store；返回 fn 的结果。
pub fn mutate_store<T>(f: impl FnOnce(&mut Value) -> Res<T>) -> Res<T> {
    let cur = load_store();
    let mut cur: Value =
        serde_json::from_str(&serde_json::to_string(&cur).unwrap_or_default()).unwrap_or_else(|_| json!({}));
    let result = f(&mut cur)?;
    save_store(&cur);
    Ok(result)
}

/// settings 里按数组维护的键（写入时统一归一化）
pub fn to_array_setting(v: &Value) -> Vec<String> {
    match v {
        Value::Array(arr) => arr
            .iter()
            .map(|x| x.as_str().unwrap_or_default().trim().to_string())
            .filter(|s| !s.is_empty())
            .collect(),
        Value::String(s) => s
            .split(',')
            .map(|x| x.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect(),
        _ => vec![],
    }
}

/// JSON Pointer 段转义（键里含 `~` 或 `/` 时用）
#[allow(dead_code)]
pub fn json_pointer_escape(s: &str) -> String {
    s.replace('~', "~0").replace('/', "~1")
}
