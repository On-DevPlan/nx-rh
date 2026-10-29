// 工作树模块 service：git 原语之上的业务 —— 与 worktrees/svc/* 对齐。
// 工作树清单以 git 为准；store 只登记 git 不知道的东西（扩展文件 + 配置）。

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::core::errors::{bad_input, blocked, conflict, external, not_found, Res};
use crate::core::git::{
    self, ahead_behind, branch_exists, check_ignore, current_branch, git_common_dir, is_dirty,
    is_work_tree, parse_worktree_porcelain, rev_parse, top_level, worktree_porcelain,
};
use crate::core::gitignore::{concrete_entries, ignore_key, parse_gitignore};
use crate::core::open::open_path;
use crate::core::paths::{absolutize, cwd_scope, home_dir, project_root};
use crate::core::store::{load_store, mutate_store, new_id};

// ─── 命名与默认配置 ───────────────────────────────────────────────────

/// 描述 → 目录/分支段。中文等无拉丁字符时退化为带短码的 task 名。
pub fn slug(s: &str) -> String {
    let mut out = String::new();
    // NFKD 近似：直接丢非 ascii 字母数字
    for c in s.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let mut trimmed = out.trim_matches('-').to_string();
    if trimmed.len() > 60 {
        trimmed = trimmed[..60].to_string();
    }
    if trimmed.is_empty() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default();
        trimmed = format!("task-{}", &to_base36(now.as_secs())[..4.min(to_base36(now.as_secs()).len())]);
    }
    trimmed
}

fn to_base36(n: u64) -> String {
    const CHARS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut n = n;
    let mut out = Vec::new();
    if n == 0 {
        return "0".into();
    }
    while n > 0 {
        out.push(CHARS[(n % 36) as usize] as char);
        n /= 36;
    }
    out.into_iter().rev().collect()
}

pub fn default_config(main_path: &str) -> Value {
    json!({
        "branchPrefix": "feature/",
        "baseBranch": "main",
        "worktreeRoot": home_dir()
            .join(".nx-rh-rs")
            .join("worktrees")
            .join(slug(&Path::new(main_path).file_name().map(|n| n.to_string_lossy()).unwrap_or_default()))
            .to_string_lossy()
            .replace('/', "\\")
    })
}

// ─── 主仓库定位（业务策略）────────────────────────────────────────────

pub struct MainRepo {
    pub git: bool,
    pub path: String,
    pub top: String,
    pub name: String,
    pub linked: bool,
}

pub fn resolve_main_repo_info() -> MainRepo {
    let start = project_root().to_string_lossy().to_string();
    let start_path = PathBuf::from(&start);
    if !is_work_tree(&start_path) {
        return MainRepo {
            git: false,
            path: start.clone(),
            top: start.clone(),
            name: file_name_of(&start),
            linked: false,
        };
    }
    let top: String = top_level(&start_path).unwrap_or_else(|| start.clone());
    let common_raw = git_common_dir(&start_path);
    let main;
    match common_raw {
        None => main = top.clone(),
        Some(c) if c == ".git" => main = top.clone(),
        Some(c) => {
            let common_abs = if Path::new(&c).is_absolute() { c.clone() } else { absolutize(&start_path.join(&c)).to_string_lossy().to_string() };
            main = if file_name_of(&common_abs) == ".git" {
                Path::new(&common_abs).parent().map(|p| p.to_string_lossy().to_string()).unwrap_or(top.clone())
            } else {
                top.clone()
            };
        }
    }
    MainRepo {
        git: true,
        path: main.clone(),
        top: top.clone(),
        name: file_name_of(&main),
        linked: top.to_lowercase() != main.to_lowercase(),
    }
}

fn file_name_of(p: &str) -> String {
    Path::new(p)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| p.to_string())
}

// ─── 状态桶 ───────────────────────────────────────────────────────────

pub struct Bucket {
    pub main: MainRepo,
    /// 这份状态在 store 里的键（= cwdScope 归一后的路径）。
    /// 目前读侧都直接用局部变量算 key，字段留着是为了让 Bucket 自描述、便于排障。
    #[allow(dead_code)]
    pub key: String,
    pub config: Value,
    pub extensions: Vec<Value>,
}

pub fn get_bucket() -> Bucket {
    let main = resolve_main_repo_info();
    let defaults = default_config(&main.path);
    if !main.git {
        let key = cwd_scope(Some(Path::new(&main.path)));
        return Bucket {
            main,
            key,
            config: defaults,
            extensions: vec![],
        };
    }
    let store = load_store();
    let key = cwd_scope(Some(Path::new(&main.path)));
    let bucket = store
        .pointer(&format!(
            "/worktreeState/{}",
            crate::modules::skills::remote_repo::json_pointer_escape(&key)
        ))
        .cloned()
        .unwrap_or(json!({}));
    let mut config = defaults.clone();
    if let Some(disk) = bucket["config"].as_object() {
        for (k, v) in disk {
            config[k.as_str()] = v.clone();
        }
    }
    let extensions = bucket["extensions"].as_array().cloned().unwrap_or_default();
    Bucket { main, key, config, extensions }
}

pub fn patch_bucket<T>(main_path: &str, f: impl FnOnce(&mut Value) -> Res<T>) -> Res<T> {
    let key = cwd_scope(Some(Path::new(main_path)));
    let ptr = crate::modules::skills::remote_repo::json_pointer_escape(&key);
    mutate_store(|s| {
        if s.pointer(&format!("/worktreeState/{}", ptr)).is_none() {
            s["worktreeState"][&ptr] = json!({ "config": {}, "extensions": [] });
        }
        let b = &mut s["worktreeState"][&ptr];
        let defaults = default_config(main_path);
        let mut config = defaults.clone();
        if let Some(disk) = b["config"].as_object() {
            for (k, v) in disk {
                config[k.as_str()] = v.clone();
            }
        }
        b["config"] = config;
        if !b["extensions"].is_array() {
            b["extensions"] = json!([]);
        }
        f(b)
    })
}

// ─── 指纹（变更检测）─────────────────────────────────────────────────

pub fn stat_or_null(p: &Path) -> Option<std::fs::Metadata> {
    std::fs::metadata(p).ok()
}

const WALK_FILE_CAP: usize = 5000;

/// 文件：小文件 sha256 内容；大文件 size+mtime。目录：清单 sha256。
pub fn fingerprint(abs: &Path, st: &std::fs::Metadata) -> String {
    use sha2::{Digest, Sha256};
    fn sha256_hex(data: &[u8]) -> String {
        let mut h = Sha256::new();
        h.update(data);
        hex::encode(h.finalize())
    }
    if st.is_file() {
        if st.len() <= 2 * 1024 * 1024 {
            if let Ok(buf) = std::fs::read(abs) {
                return format!("f:{}", sha256_hex(&buf));
            }
            return "f:?".into();
        }
        let mtime = st
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis())
            .unwrap_or(0);
        return format!("f:l:{}:{}", st.len(), mtime);
    }
    if !st.is_dir() {
        let mtime = st
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis())
            .unwrap_or(0);
        return format!("u:{}:{}", st.len(), mtime);
    }

    let mut lines: Vec<String> = Vec::new();
    let mut truncated = false;
    fn walk(dir: &Path, rel: &str, lines: &mut Vec<String>, count: &mut usize, truncated: &mut bool) {
        if *truncated {
            return;
        }
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for e in entries.flatten() {
            if *truncated {
                return;
            }
            let name = e.file_name().to_string_lossy().to_string();
            if name == ".git" {
                continue;
            }
            let a = dir.join(&name);
            let r = if rel.is_empty() { name.clone() } else { format!("{}/{}", rel, name) };
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                walk(&a, &r, lines, count, truncated);
                continue;
            }
            if !ft.is_file() {
                continue;
            }
            let Ok(md) = e.metadata() else { continue };
            let mtime = md
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis())
                .unwrap_or(0);
            lines.push(format!("{}:{}:{}", r, md.len(), mtime));
            *count += 1;
            if *count > WALK_FILE_CAP {
                *truncated = true;
                return;
            }
        }
    }
    let mut count = 0usize;
    walk(abs, "", &mut lines, &mut count, &mut truncated);
    lines.sort();
    format!(
        "d:{}{}",
        sha256_hex(lines.join("\n").as_bytes()),
        if truncated { "+trunc" } else { "" }
    )
}

// ─── 工作树清单 ───────────────────────────────────────────────────────

pub fn list_worktrees_with(base: &str) -> Res<Value> {
    let bucket = get_bucket();
    if !bucket.main.git {
        return Ok(json!({
            "main": main_json(&bucket.main),
            "config": bucket.config,
            "worktrees": []
        }));
    }
    let records = parse_worktree_porcelain(&worktree_porcelain(Path::new(&bucket.main.path))?);
    let base_ref = if base.is_empty() {
        bucket.config["baseBranch"].as_str().unwrap_or("main").to_string()
    } else {
        base.to_string()
    };
    let mut worktrees: Vec<Value> = Vec::new();
    for r in &records {
        let is_main = r.path == bucket.main.path;
        let name = if is_main { "main".to_string() } else { file_name_of(&r.path) };
        let dirty = is_dirty(Path::new(&r.path));
        let mut counts = (None, None);
        if let Some(_branch) = &r.branch {
            if !base_ref.is_empty() {
                let ab = ahead_behind(Path::new(&r.path), &base_ref);
                counts = (ab.ahead, ab.behind);
            }
        }
        let mut ext_missing = 0usize;
        for e in &bucket.extensions {
            if e["outside"].as_bool().unwrap_or(false) {
                continue;
            }
            let rel = e["relPath"].as_str().unwrap_or("");
            if stat_or_null(&Path::new(&r.path).join(rel)).is_none() {
                ext_missing += 1;
            }
        }
        worktrees.push(json!({
            "path": r.path,
            "name": name,
            "branch": r.branch,
            "head": r.head,
            "isMain": is_main,
            "detached": r.detached,
            "locked": r.locked,
            "dirty": dirty,
            "ahead": counts.0,
            "behind": counts.1,
            "extMissing": ext_missing,
        }));
    }
    Ok(json!({
        "main": main_json(&bucket.main),
        "config": bucket.config,
        "worktrees": worktrees
    }))
}

pub fn list_worktrees() -> Res<Value> {
    list_worktrees_with("")
}

fn main_json(m: &MainRepo) -> Value {
    json!({
        "git": m.git, "path": m.path, "top": m.top,
        "name": m.name, "linked": m.linked
    })
}

pub fn match_worktree<'a>(worktrees: &'a [Value], r: &str) -> Option<&'a Value> {
    let r = r.trim();
    if r.is_empty() {
        return None;
    }
    let norm = |p: &str| absolutize(Path::new(p)).to_string_lossy().to_lowercase();
    worktrees.iter().find(|w| w["name"].as_str() == Some(r))
        .or_else(|| worktrees.iter().find(|w| norm(w["path"].as_str().unwrap_or("")) == norm(r)))
        .or_else(|| worktrees.iter().find(|w| w["branch"].as_str() == Some(r)))
        .or_else(|| worktrees.iter().find(|w| file_name_of(w["path"].as_str().unwrap_or("")) == r))
        .or_else(|| {
            if r == "." {
                worktrees.iter().find(|w| !w["isMain"].as_bool().unwrap_or(true))
            } else {
                None
            }
        })
}

pub fn get_worktree(r: &str) -> Res<Value> {
    let listing = list_worktrees()?;
    if !listing["main"]["git"].as_bool().unwrap_or(false) {
        return Err(not_found(format!(
            "不是 git 仓库，没有工作树: {}",
            listing["main"]["path"].as_str().unwrap_or("")
        )));
    }
    let worktrees = listing["worktrees"].as_array().cloned().unwrap_or_default();
    let Some(wt) = match_worktree(&worktrees, r) else {
        return Err(not_found(format!("工作树不存在: {}（用 nx-rh-rs wt list 查看）", r)));
    };
    let mut wt = wt.clone();
    let path = wt["path"].as_str().unwrap_or("").to_string();
    wt["log"] = json!(git::git(Path::new(&path), &["log", "--oneline", "-n", "8"], true)
        .map(|o| o.stdout.trim_end().to_string())
        .unwrap_or_default());
    wt["extensions"] = inspect_at(&path)?;
    Ok(wt)
}

// ─── 生命周期：创建 / 挂载 / 移除 / 切换 / 打开 ──────────────────────

pub fn add_worktree(input: &Value) -> Res<Value> {
    let description = input["description"].as_str().unwrap_or("").trim().to_string();
    if description.is_empty() {
        return Err(bad_input(
            "用法: nx-rh-rs wt add <描述> [--name N] [--base B] [--root R] —— 描述不能为空",
        ));
    }
    let bucket = get_bucket();
    if !bucket.main.git {
        return Err(blocked(format!("当前目录不是 git 仓库: {}", bucket.main.path)));
    }
    let session = slug(input["name"].as_str().unwrap_or(&description));
    let prefix = bucket.config["branchPrefix"].as_str().unwrap_or("feature/").to_string();
    let branch = format!("{}{}", prefix, session);
    let root = absolutize(Path::new(
        input["root"].as_str().unwrap_or(bucket.config["worktreeRoot"].as_str().unwrap_or("")),
    ));
    let target = root.join(&session);
    let base_ref = input["base"]
        .as_str()
        .unwrap_or(bucket.config["baseBranch"].as_str().unwrap_or(""))
        .trim()
        .to_string();

    if stat_or_null(&target).is_some() {
        return Err(conflict(format!(
            "目标目录已存在: {}（换 --name，或强制用 --force）",
            target.display()
        )));
    }
    if !prefix.is_empty() && branch_exists(Path::new(&bucket.main.path), &branch) {
        return Err(conflict(format!(
            "分支已存在: {}（用 nx-rh-rs wt checkout {} 挂成工作树）",
            branch, branch
        )));
    }

    std::fs::create_dir_all(&root).map_err(crate::core::errors::io_err)?;
    let mut args: Vec<String> = vec!["worktree".into(), "add".into()];
    if input["force"].as_bool().unwrap_or(false) {
        args.push("--force".into());
    }
    if !branch.is_empty() {
        args.push("-b".into());
        args.push(branch.clone());
    }
    args.push(target.to_string_lossy().to_string());
    if !base_ref.is_empty() {
        args.push(base_ref);
    }
    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    git::git(Path::new(&bucket.main.path), &arg_refs, false)?;

    Ok(json!({
        "status": "ok", "name": session,
        "branch": if branch.is_empty() { Value::Null } else { json!(branch) },
        "path": target.to_string_lossy().replace('/', "\\"),
        "cd": target.to_string_lossy().replace('/', "\\")
    }))
}

pub fn checkout_worktree(input: &Value) -> Res<Value> {
    let branch = input["branch"].as_str().unwrap_or("").trim().to_string();
    if branch.is_empty() {
        return Err(bad_input("用法: nx-rh-rs wt checkout <分支> [--name N] [--root R] —— 缺少分支名"));
    }
    let bucket = get_bucket();
    if !bucket.main.git {
        return Err(blocked(format!("当前目录不是 git 仓库: {}", bucket.main.path)));
    }
    if !branch_exists(Path::new(&bucket.main.path), &branch) {
        return Err(not_found(format!("分支不存在: {}（先创建或 fetch）", branch)));
    }
    let records =
        parse_worktree_porcelain(&worktree_porcelain(Path::new(&bucket.main.path))?);
    if let Some(occupied) = records.iter().find(|r| r.branch.as_deref() == Some(&branch)) {
        return Err(conflict(format!("分支已被工作树占用: {}", occupied.path)));
    }
    let session = slug(input["name"].as_str().unwrap_or(&branch));
    let root = absolutize(Path::new(
        input["root"].as_str().unwrap_or(bucket.config["worktreeRoot"].as_str().unwrap_or("")),
    ));
    let target = root.join(&session);
    if stat_or_null(&target).is_some() {
        return Err(conflict(format!("目标目录已存在: {}", target.display())));
    }
    std::fs::create_dir_all(&root).map_err(crate::core::errors::io_err)?;
    let mut args: Vec<String> = vec!["worktree".into(), "add".into()];
    if input["force"].as_bool().unwrap_or(false) {
        args.push("--force".into());
    }
    args.push(target.to_string_lossy().to_string());
    args.push(branch.clone());
    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    git::git(Path::new(&bucket.main.path), &arg_refs, false)?;
    Ok(json!({
        "status": "ok", "name": session, "branch": branch,
        "path": target.to_string_lossy().replace('/', "\\"),
        "cd": target.to_string_lossy().replace('/', "\\")
    }))
}

pub fn remove_worktree(r: &str, del_branch: bool, force: bool) -> Res<Value> {
    let listing = list_worktrees()?;
    if !listing["main"]["git"].as_bool().unwrap_or(false) {
        return Err(blocked(format!(
            "不是 git 仓库: {}",
            listing["main"]["path"].as_str().unwrap_or("")
        )));
    }
    let worktrees = listing["worktrees"].as_array().cloned().unwrap_or_default();
    let Some(wt) = match_worktree(&worktrees, r) else {
        return Err(not_found(format!("工作树不存在: {}（用 nx-rh-rs wt list 查看）", r)));
    };
    let wt = wt.clone();
    let path = wt["path"].as_str().unwrap_or("").to_string();
    if wt["isMain"].as_bool().unwrap_or(false) {
        return Err(blocked(format!("不能移除主工作树: {}", path)));
    }
    if wt["dirty"].as_bool().unwrap_or(false) && !force {
        return Ok(json!({
            "status": "blocked", "name": wt["name"], "path": path,
            "reason": "工作树有未提交改动；确认删除加 --force"
        }));
    }
    let main_path = listing["main"]["path"].as_str().unwrap_or("").to_string();
    let mut args: Vec<&str> = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(&path);
    let rm = git::git(Path::new(&main_path), &args, true);
    if let Err(e) = rm {
        if !force {
            return Ok(json!({ "status": "blocked", "name": wt["name"], "path": path, "reason": e.message }));
        }
        return Err(external(format!("移除工作树失败: {}", e.message)));
    }
    let rm_out = rm.unwrap();
    if rm_out.code != 0 {
        let detail = if rm_out.stderr.trim().is_empty() { rm_out.stdout.trim() } else { rm_out.stderr.trim() };
        if !force {
            return Ok(json!({ "status": "blocked", "name": wt["name"], "path": path, "reason": detail }));
        }
        return Err(external(format!("移除工作树失败: {}", detail)));
    }

    let branch = wt["branch"].as_str().unwrap_or("").to_string();
    if del_branch && !branch.is_empty() {
        let d = git::git(Path::new(&main_path), &["branch", "-d", &branch], true).unwrap();
        if d.code == 0 {
            return Ok(json!({ "status": "ok", "removed": wt["name"], "path": path, "branchDeleted": true }));
        } else if force {
            git::git(Path::new(&main_path), &["branch", "-D", &branch], false)?;
            return Ok(json!({ "status": "ok", "removed": wt["name"], "path": path, "branchDeleted": true }));
        } else {
            return Ok(json!({
                "status": "ok", "removed": wt["name"], "path": path,
                "branchDeleted": false, "branchKept": branch,
                "note": "分支未完全合并，已保留；连同删除再加 --force"
            }));
        }
    }
    Ok(json!({ "status": "ok", "removed": wt["name"], "path": path, "branchDeleted": false }))
}

pub fn switch_worktree(r: &str) -> Res<Value> {
    let listing = list_worktrees()?;
    let worktrees = listing["worktrees"].as_array().cloned().unwrap_or_default();
    let Some(wt) = match_worktree(&worktrees, r) else {
        return Err(not_found(format!("工作树不存在: {}（用 nx-rh-rs wt list 查看）", r)));
    };
    let path = wt["path"].as_str().unwrap_or("").to_string();
    Ok(json!({ "status": "ok", "name": wt["name"], "path": path, "cd": path }))
}

pub fn open_worktree(r: &str) -> Res<Value> {
    let listing = list_worktrees()?;
    let worktrees = listing["worktrees"].as_array().cloned().unwrap_or_default();
    let Some(wt) = match_worktree(&worktrees, r) else {
        return Err(not_found(format!("工作树不存在: {}", r)));
    };
    let path = wt["path"].as_str().unwrap_or("").to_string();
    open_path(&path);
    Ok(json!({ "status": "ok", "opened": path }))
}

// ─── 扩展文件在某个目标根上的状态评估 ────────────────────────────────

/// 「需要特殊关注」的本地工具/测试目录。
const ATTENTION_NAMES: [&str; 8] =
    [".tool", ".tools", ".tooling", ".local", ".tmp", ".cache", ".scripts", ".scratch"];

pub fn attention_of(rel: &str, kind: &str) -> bool {
    let base = rel.split('/').next_back().unwrap_or("").to_lowercase();
    if ATTENTION_NAMES.contains(&base.as_str()) {
        return true;
    }
    if kind == "dir" && !rel.contains('/') && base.starts_with('.') && base != ".git" {
        return true;
    }
    false
}

pub fn inspect_at(target_path: &str) -> Res<Value> {
    inspect_at_bucket(target_path, &get_bucket())
}

pub fn inspect_at_bucket(target_path: &str, bucket: &Bucket) -> Res<Value> {
    let is_main = target_path.to_lowercase() == bucket.main.path.to_lowercase();
    let mut items: Vec<Value> = Vec::new();
    let (mut present, mut changed, mut missing, mut up_to_date, mut differs, mut attention) =
        (0usize, 0usize, 0usize, 0usize, 0usize, 0usize);

    for rec in &bucket.extensions {
        let rel = rec["relPath"].as_str().unwrap_or("");
        let abs_path = rec["absPath"].as_str().unwrap_or("");
        let dest = if is_main {
            PathBuf::from(abs_path)
        } else {
            Path::new(target_path).join(rel)
        };
        let st = stat_or_null(&dest);
        let item_attention = attention_of(rel, rec["kind"].as_str().unwrap_or(""));
        let mut base_item = json!({
            "id": rec["id"],
            "rel": rel,
            "label": rec["label"].as_str().unwrap_or(""),
            "outside": rec["outside"].as_bool().unwrap_or(false),
            "attention": item_attention,
            "mainPath": abs_path,
        });
        if item_attention {
            attention += 1;
        }

        let Some(st) = st else {
            base_item["present"] = json!(false);
            items.push(base_item);
            missing += 1;
            continue;
        };
        let fp = fingerprint(&dest, &st);
        let is_dir = st.is_dir();
        let mtime = st
            .modified()
            .ok()
            .map(|t| {
                let dt: chrono::DateTime<chrono::Utc> = t.into();
                dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            })
            .unwrap_or_default();
        base_item["present"] = json!(true);
        base_item["kind"] = json!(if is_dir { "dir" } else { "file" });
        base_item["fingerprint"] = json!(fp);
        base_item["size"] = json!(st.len());
        base_item["mtime"] = json!(mtime);
        if is_main {
            let is_changed = fp != rec["fingerprint"].as_str().unwrap_or("");
            base_item["changed"] = json!(is_changed);
            if is_changed {
                changed += 1;
            } else {
                present += 1;
            }
        } else {
            let main_st = stat_or_null(Path::new(abs_path));
            let main_fp = match &main_st {
                Some(ms) => fingerprint(Path::new(abs_path), ms),
                None => String::new(),
            };
            let is_up = !main_fp.is_empty() && fp == main_fp;
            base_item["upToDate"] = json!(is_up);
            if is_up {
                up_to_date += 1;
            } else {
                differs += 1;
            }
        }
        items.push(base_item);
    }

    Ok(json!({
        "target": absolutize(Path::new(target_path)).to_string_lossy(),
        "isMain": is_main,
        "items": items,
        "summary": if is_main {
            json!({ "registered": bucket.extensions.len(), "present": present, "changed": changed, "missing": missing, "attention": attention })
        } else {
            json!({ "registered": bucket.extensions.len(), "upToDate": up_to_date, "differs": differs, "missing": missing, "attention": attention })
        }
    }))
}

// ─── 主项目上下文 ─────────────────────────────────────────────────────

pub fn get_context(log: u64) -> Res<Value> {
    let n = if log == 0 { 5 } else { log };
    let bucket = get_bucket();
    if !bucket.main.git {
        return Ok(json!({
            "git": false, "project": bucket.main.path,
            "message": "当前目录不是 git 仓库"
        }));
    }
    let main_path = Path::new(&bucket.main.path);
    let main_branch = current_branch(main_path);
    let head = rev_parse(main_path, "HEAD").unwrap_or_default();
    let main_dirty = is_dirty(main_path);
    let main_log = git::git(main_path, &["log", "--oneline", "-n", &n.to_string()], true)
        .map(|o| o.stdout.trim_end().to_string())
        .unwrap_or_default();
    let main_status = git::git(main_path, &["status", "-sb"], true)
        .map(|o| o.stdout.trim_end().to_string())
        .unwrap_or_default();

    let mut current_worktree: Value = Value::Null;
    if bucket.main.linked {
        let top = Path::new(&bucket.main.top);
        let cur_branch = current_branch(top);
        let r#ref = if main_branch.is_empty() { head.clone() } else { main_branch.clone() };
        let ab = ahead_behind(top, &r#ref);
        current_worktree = json!({
            "path": bucket.main.top,
            "branch": cur_branch,
            "dirty": is_dirty(top),
            "divergence": { "relativeTo": r#ref, "ahead": ab.ahead, "behind": ab.behind }
        });
    }

    let main_ext = inspect_at_bucket(&bucket.main.path, &bucket)?;
    let here_ext = if bucket.main.linked {
        Some(inspect_at_bucket(&bucket.main.top, &bucket)?)
    } else {
        None
    };

    let attention_items: Vec<Value> = main_ext["items"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|i| i["attention"].as_bool().unwrap_or(false))
        .collect();
    let attention: Vec<Value> = attention_items
        .iter()
        .map(|i| {
            json!({
                "rel": i["rel"], "present": i["present"],
                "mainPath": i["mainPath"].as_str().unwrap_or("")
            })
        })
        .collect();

    let mut suggested: Vec<String> = Vec::new();
    if main_dirty {
        suggested.push(format!("主工作树有未提交改动：git -C \"{}\" status -sb", bucket.main.path));
    }
    if !current_worktree.is_null() {
        let ahead = current_worktree.pointer("/divergence/ahead").and_then(|a| a.as_u64()).unwrap_or(0);
        let behind = current_worktree.pointer("/divergence/behind").and_then(|b| b.as_u64()).unwrap_or(0);
        if behind > 0 {
            suggested.push(format!("当前工作树落后 {} 个提交：nx-rh-rs wt rebase", behind));
        }
        if ahead > 0 {
            suggested.push(format!("当前工作树领先 {} 个提交：提 PR 或自行合并", ahead));
        }
    }
    if let Some(here) = &here_ext {
        let missing = here.pointer("/summary/missing").and_then(|m| m.as_u64()).unwrap_or(0);
        if missing > 0 {
            let att_missing: Vec<String> = here["items"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter(|i| !i["present"].as_bool().unwrap_or(false) && i["attention"].as_bool().unwrap_or(false))
                .filter_map(|i| i["rel"].as_str().map(|s| s.to_string()))
                .collect();
            suggested.push(format!(
                "当前工作树缺 {} 个参考项（只读文档，nx-rh-rs 不代复制）；需要时从主项目路径自行复制{}",
                missing,
                if att_missing.is_empty() { String::new() } else { format!("；值得关注: {}", att_missing.join(", ")) }
            ));
        }
    }
    let changed = main_ext.pointer("/summary/changed").and_then(|c| c.as_u64()).unwrap_or(0);
    if changed > 0 {
        suggested.push(format!("主项目有 {} 个登记项已变更：nx-rh-rs wt ext list", changed));
    }
    if !bucket.main.linked && !attention.is_empty() {
        let names: Vec<String> = attention
            .iter()
            .filter_map(|a| a["rel"].as_str().map(|s| s.to_string()))
            .collect();
        suggested.push(format!(
            "主项目有本地工具目录可只读参考: {}（被 ignore，不进工作树）",
            names.join(", ")
        ));
    }

    Ok(json!({
        "git": true,
        "role": if bucket.main.linked { "worktree" } else { "main" },
        "main": {
            "path": bucket.main.path, "branch": main_branch, "head": head,
            "dirty": main_dirty, "status": main_status, "log": main_log
        },
        "currentWorktree": current_worktree,
        "baseBranch": bucket.config["baseBranch"],
        "attention": attention,
        "extensions": {
            "main": main_ext["summary"],
            "here": here_ext.as_ref().map(|h| h["summary"].clone()).unwrap_or(Value::Null)
        },
        "extItems": here_ext.as_ref().map(|h| h["items"].clone()).unwrap_or_else(|| main_ext["items"].clone()),
        "suggested": suggested
    }))
}

/// 聚合（bootstrap 用；非 git 目录安全降级，绝不抛）。
pub fn overview() -> Value {
    match try_overview() {
        Ok(v) => v,
        Err(e) => json!({ "git": false, "project": project_root().to_string_lossy(), "error": e.message }),
    }
}

fn try_overview() -> Res<Value> {
    let bucket = get_bucket();
    if !bucket.main.git {
        return Ok(json!({ "git": false, "project": bucket.main.path }));
    }
    let listing = list_worktrees_with("")?;
    let eval_target = if bucket.main.linked { bucket.main.top.clone() } else { bucket.main.path.clone() };
    let ext = inspect_at_bucket(&eval_target, &bucket)?;
    Ok(json!({
        "git": true,
        "main": bucket.main.path,
        "currentWorktree": if bucket.main.linked { json!(bucket.main.top) } else { Value::Null },
        "config": bucket.config,
        "worktrees": listing["worktrees"],
        "extTarget": ext["target"],
        "extSummary": ext["summary"],
        "extItems": ext["items"]
    }))
}

// ─── 扩展文件：盘点 / 登记 / 发现 / 改 / 删 ──────────────────────────

pub fn list_extensions(target: &str) -> Res<Value> {
    let bucket = get_bucket();
    if !bucket.main.git {
        return Ok(json!({
            "target": bucket.main.path, "isMain": true, "items": [],
            "summary": { "registered": 0 }
        }));
    }
    let mut target_path = bucket.main.path.clone();
    if !target.is_empty() {
        let listing = list_worktrees()?;
        let worktrees = listing["worktrees"].as_array().cloned().unwrap_or_default();
        let Some(wt) = match_worktree(&worktrees, target) else {
            return Err(not_found(format!("工作树不存在: {}", target)));
        };
        target_path = wt["path"].as_str().unwrap_or("").to_string();
    } else if bucket.main.linked {
        target_path = bucket.main.top.clone();
    }
    inspect_at_bucket(&target_path, &bucket)
}

pub fn add_extension(input: &Value) -> Res<Value> {
    let abs0 = input["abspath"]
        .as_str()
        .or_else(|| input["abs"].as_str())
        .or_else(|| input["path"].as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if abs0.is_empty() {
        return Err(bad_input("用法: nx-rh-rs wt ext add <绝对路径> [--label L] [--force] —— 缺少路径"));
    }
    let bucket = get_bucket();
    if !bucket.main.git {
        return Err(blocked(format!("当前目录不是 git 仓库: {}", bucket.main.path)));
    }
    let abs = absolutize(Path::new(&abs0)).to_string_lossy().to_string();
    let abs_path = Path::new(&abs);
    let Some(st) = stat_or_null(abs_path) else {
        return Err(not_found(format!("文件不存在: {}", abs)));
    };

    let rel = abs
        .strip_prefix(&bucket.main.path)
        .unwrap_or(&abs)
        .trim_start_matches(['\\', '/'])
        .replace('\\', "/");
    let outside = abs.to_lowercase().strip_prefix(bucket.main.path.to_lowercase().as_str()).is_none();

    if !input["force"].as_bool().unwrap_or(false) {
        let code = check_ignore(Path::new(&bucket.main.path), &abs);
        if code == 1 {
            return Err(blocked(format!(
                "文件未被 git 忽略（被跟踪或不在 .gitignore）: {}；扩展文件用于登记被忽略文件，确认登记加 --force",
                if outside { abs.clone() } else { rel.clone() }
            )));
        }
    }

    let fp = fingerprint(abs_path, &st);
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let record = json!({
        "id": new_id("x"),
        "absPath": abs,
        "relPath": rel,
        "outside": outside,
        "label": input["label"].as_str().unwrap_or("").trim(),
        "kind": if st.is_dir() { "dir" } else { "file" },
        "fingerprint": fp,
        "size": st.len(),
        "mtime": now,
        "registeredAt": now,
        "updatedAt": now,
    });
    let abs_for_check = abs.to_lowercase();
    let mut record_out = record.clone();
    patch_bucket(&bucket.main.path, |b| {
        let exts = b["extensions"].as_array().cloned().unwrap_or_default();
        if exts
            .iter()
            .any(|e| e["absPath"].as_str().unwrap_or("").to_lowercase() == abs_for_check)
        {
            return Err(conflict(format!("扩展文件已登记: {}", abs)));
        }
        b["extensions"].as_array_mut().unwrap().push(record.clone());
        record_out = record.clone();
        Ok(())
    })?;
    let mut out = record_out;
    out["status"] = json!("ok");
    Ok(out)
}

/// 发现被忽略文件：.gitignore 具体条目 + git ls-files。
pub fn discover_extensions(apply: bool) -> Res<Value> {
    let bucket = get_bucket();
    if !bucket.main.git {
        return Err(blocked(format!("当前目录不是 git 仓库: {}", bucket.main.path)));
    }
    let mut proposals: std::collections::BTreeMap<String, String> = std::collections::BTreeMap::new();
    // 工作树根绝不能被当成扩展文件
    let root_rel0 = bucket.config["worktreeRoot"]
        .as_str()
        .unwrap_or("")
        .strip_prefix(&bucket.main.path)
        .unwrap_or("")
        .trim_start_matches(['\\', '/'])
        .replace('\\', "/");
    let wt_root_rel = if !root_rel0.is_empty() && !root_rel0.contains("..") {
        Some(root_rel0.trim_end_matches('/').to_string())
    } else {
        None
    };

    let gi_text = std::fs::read_to_string(Path::new(&bucket.main.path).join(".gitignore")).unwrap_or_default();
    for e in concrete_entries(&parse_gitignore(&gi_text)) {
        let full = Path::new(&bucket.main.path).join(&e.path);
        let full_s = full.to_string_lossy().to_string();
        let rel = full_s
            .strip_prefix(bucket.main.path.as_str())
            .unwrap_or(&e.path)
            .trim_start_matches(['\\', '/'])
            .to_string();
        if !rel.contains("..") {
            proposals
                .entry(rel.replace('\\', "/").to_string())
                .or_insert_with(|| "gitignore".into());
        }
    }

    let ls = git::git(
        Path::new(&bucket.main.path),
        &["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"],
        true,
    )?;
    if ls.code == 0 {
        for line in ls.stdout.lines() {
            let p = line.trim();
            if p.is_empty() {
                continue;
            }
            let p = p.replace('\\', "/").trim_matches('/').to_string();
            if p.is_empty() || p == ".git" {
                continue;
            }
            if let Some(wtr) = &wt_root_rel {
                if p == *wtr || p.starts_with(&format!("{}/", wtr)) {
                    continue;
                }
            }
            proposals.entry(p).or_insert_with(|| "git".into());
        }
    }

    let registered: std::collections::HashSet<String> = bucket
        .extensions
        .iter()
        .filter_map(|e| e["relPath"].as_str().map(|s| s.to_string()))
        .collect();
    let mut items: Vec<Value> = Vec::new();
    for (rel, source) in proposals.iter().take(1000) {
        let abs = Path::new(&bucket.main.path).join(rel);
        let st = stat_or_null(&abs);
        items.push(json!({
            "rel": rel,
            "source": source,
            "exists": st.is_some(),
            "kind": st.map(|s| if s.is_dir() { "dir" } else { "file" }),
            "alreadyRegistered": registered.contains(rel)
        }));
    }

    let registrable: Vec<Value> = items
        .iter()
        .filter(|i| i["exists"].as_bool().unwrap_or(false) && !i["alreadyRegistered"].as_bool().unwrap_or(false))
        .cloned()
        .collect();
    let mut added: Vec<Value> = Vec::new();
    if apply {
        for i in &registrable {
            let abs = Path::new(&bucket.main.path)
                .join(i["rel"].as_str().unwrap_or(""))
                .to_string_lossy()
                .to_string();
            if let Ok(r) = add_extension(&json!({ "abspath": abs, "force": true })) {
                added.push(r);
            }
        }
    }

    Ok(json!({
        "apply": apply,
        "proposals": items,
        "summary": {
            "found": items.len(),
            "registrable": registrable.len(),
            "alreadyRegistered": items.iter().filter(|i| i["alreadyRegistered"].as_bool().unwrap_or(false)).count(),
            "added": added.len()
        },
        "added": added
    }))
}

fn match_extension(list: &[Value], r: &str) -> Option<Value> {
    let r = r.trim();
    if r.is_empty() {
        return None;
    }
    let target = absolutize(Path::new(r)).to_string_lossy().to_lowercase();
    list.iter()
        .find(|e| e["id"].as_str() == Some(r) || e["relPath"].as_str() == Some(r))
        .or_else(|| {
            list.iter()
                .find(|e| e["absPath"].as_str().unwrap_or("").to_lowercase() == target)
        })
        .cloned()
}

pub fn get_extension(r: &str) -> Res<Value> {
    let bucket = get_bucket();
    let Some(rec) = match_extension(&bucket.extensions, r) else {
        return Err(not_found(format!("扩展文件不存在: {}", r)));
    };
    let inspected = inspect_at_bucket(&bucket.main.path, &bucket)?;
    let state = inspected["items"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .find(|i| i["id"].as_str() == Some(rec["id"].as_str().unwrap_or("")));
    let mut out = rec;
    out["state"] = state.unwrap_or(Value::Null);
    Ok(out)
}

pub fn update_extension(r: &str, label: &str) -> Res<Value> {
    let bucket = get_bucket();
    let label = label.trim().to_string();
    let r = r.to_string();
    patch_bucket(&bucket.main.path, |b| {
        let exts = b["extensions"].as_array_mut().unwrap();
        let rec = match_extension(exts, &r);
        let Some(rec) = rec else {
            return Err(not_found(format!("扩展文件不存在: {}", r)));
        };
        // 找到原位置改
        if let Some(pos) = exts.iter().position(|e| e["id"].as_str() == Some(rec["id"].as_str().unwrap_or(""))) {
            if !label.is_empty() || label.is_empty() {
                exts[pos]["label"] = json!(label);
            }
            exts[pos]["updatedAt"] = json!(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
            return Ok(exts[pos].clone());
        }
        unreachable!()
    })
}

pub fn remove_extension(r: &str) -> Res<Value> {
    let bucket = get_bucket();
    let r = r.to_string();
    patch_bucket(&bucket.main.path, |b| {
        let exts = b["extensions"].as_array_mut().unwrap();
        let Some(pos) = exts
            .iter()
            .position(|e| match_extension(std::slice::from_ref(e), &r).is_some())
        else {
            return Err(not_found(format!("扩展文件不存在: {}", r)));
        };
        let removed = exts.remove(pos);
        Ok(json!({ "status": "ok", "removed": removed["relPath"], "diskUntouched": true }))
    })
}

// ─── 配置 / 初始化 ───────────────────────────────────────────────────

pub fn get_config() -> Value {
    let bucket = get_bucket();
    let mut out = bucket.config.clone();
    out["git"] = json!(bucket.main.git);
    out["main"] = json!(bucket.main.path);
    out["currentWorktree"] = if bucket.main.linked { json!(bucket.main.top) } else { Value::Null };
    out
}

const CONFIG_FIELDS: [&str; 3] = ["branchPrefix", "baseBranch", "worktreeRoot"];

pub fn set_config(patch: &Value) -> Res<Value> {
    let main = resolve_main_repo_info();
    if !main.git {
        return Err(blocked(format!("当前目录不是 git 仓库: {}", main.path)));
    }
    patch_bucket(&main.path, |b| {
        for f in CONFIG_FIELDS {
            let v = patch.get(f).and_then(|x| x.as_str()).unwrap_or("");
            if !v.is_empty() {
                b["config"][f] = json!(v);
            }
        }
        if let Some(root) = b["config"]["worktreeRoot"].as_str() {
            if !Path::new(root).is_absolute() {
                b["config"]["worktreeRoot"] = json!(absolutize(&Path::new(&main.path).join(root)).to_string_lossy().to_string());
            }
        }
        Ok(())
    })?;
    Ok(get_config())
}

pub fn init_worktree(patch: &Value) -> Res<Value> {
    let main = resolve_main_repo_info();
    if !main.git {
        return Err(blocked(format!("当前目录不是 git 仓库，无法初始化: {}", main.path)));
    }
    let provided: Vec<&str> = CONFIG_FIELDS
        .iter()
        .filter(|f| patch.get(**f).map(|v| !v.is_null()).unwrap_or(false))
        .copied()
        .collect();
    if !provided.is_empty() {
        let mut p = json!({});
        for f in provided {
            p[f] = patch[f].clone();
        }
        set_config(&p)?;
    }
    let bucket = get_bucket();
    let root = bucket.config["worktreeRoot"].as_str().unwrap_or("").to_string();
    std::fs::create_dir_all(&root).map_err(crate::core::errors::io_err)?;

    // 工作树根若在主仓库内，登记进 .gitignore
    let mut gitignore_added: Option<String> = None;
    let rel_root = root
        .strip_prefix(&main.path)
        .unwrap_or(&root)
        .trim_start_matches(['\\', '/'])
        .replace('\\', "/");
    let inside_main = !rel_root.contains("..") && !Path::new(&rel_root).is_absolute() && !root.to_lowercase().eq_ignore_ascii_case(&main.path.to_lowercase());
    if inside_main && !rel_root.is_empty() {
        let gi_path = Path::new(&main.path).join(".gitignore");
        let text = std::fs::read_to_string(&gi_path).unwrap_or_default();
        let entry = format!("{}/", rel_root.trim_end_matches('/'));
        let have = parse_gitignore(&text).iter().any(|e| {
            ignore_key(&format!("{}{}", e.path, if e.dir_only { "/" } else { "" }))
                == ignore_key(&entry)
        });
        if !have {
            let sep = if !text.is_empty() && !text.ends_with('\n') { "\n" } else { "" };
            std::fs::write(
                &gi_path,
                format!("{}{}\n# 工作树根目录（nx-rh-rs wt init）\n{}\n", text, sep, entry),
            )
            .map_err(crate::core::errors::io_err)?;
            gitignore_added = Some(entry);
        }
    }

    let config = get_bucket().config;
    let mut out = json!({
        "status": "ok", "main": main.path, "config": config
    });
    if let Some(gi) = gitignore_added {
        out["gitignoreAdded"] = json!(gi);
    }
    Ok(out)
}

// ─── rebase / fanout ─────────────────────────────────────────────────

fn perform_rebase(wt_path: &str, base_ref: &str) -> Value {
    let r = git::git(Path::new(wt_path), &["rebase", base_ref], true);
    if let Ok(o) = &r {
        if o.code == 0 {
            return json!({ "status": "ok", "path": wt_path, "base": base_ref });
        }
    }
    let status_txt = git::git(Path::new(wt_path), &["status", "--porcelain"], true)
        .map(|o| o.stdout)
        .unwrap_or_default();
    let output = match &r {
        Ok(o) => format!("{}{}", o.stdout, o.stderr).trim().to_string(),
        Err(e) => e.message.clone(),
    };
    let lower = output.to_lowercase();
    let is_conflict = lower.contains("conflict")
        || lower.contains("failed to merge")
        || status_txt
            .lines()
            .any(|l| l.starts_with(".U") || l.starts_with("U.") || l.starts_with("AA") || l.starts_with("DD") || l.starts_with("AU") || l.starts_with("UA") || l.starts_with("DU") || l.starts_with("UD"));
    let _ = git::git(Path::new(wt_path), &["rebase", "--abort"], true);
    if is_conflict {
        json!({ "status": "conflict", "path": wt_path, "base": base_ref, "output": tail800(&output) })
    } else {
        json!({ "status": "blocked", "path": wt_path, "base": base_ref, "reason": tail800(&output) })
    }
}

fn tail800(s: &str) -> String {
    if s.len() > 800 {
        s[s.len() - 800..].to_string()
    } else {
        s.to_string()
    }
}

pub fn rebase_worktree(input: &Value) -> Res<Value> {
    let bucket = get_bucket();
    if !bucket.main.git {
        return Err(blocked(format!("不是 git 仓库: {}", bucket.main.path)));
    }
    let listing = list_worktrees()?;
    let worktrees = listing["worktrees"].as_array().cloned().unwrap_or_default();

    let r#ref = input["target"]
        .as_str()
        .or_else(|| input["ref"].as_str())
        .unwrap_or("");
    let wt: Option<Value> = if !r#ref.is_empty() {
        match_worktree(&worktrees, r#ref).cloned()
    } else if bucket.main.linked {
        worktrees.iter().find(|w| w["path"].as_str() == Some(bucket.main.top.as_str())).cloned()
    } else {
        None
    };
    let Some(wt) = wt else {
        return Err(not_found("未指定工作树，且当前不在工作树内（用 --target <工作树>）"));
    };

    let base_ref = input["base"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();
    let base_ref = if !base_ref.is_empty() {
        base_ref
    } else {
        let cb = current_branch(Path::new(&bucket.main.path));
        if !cb.is_empty() {
            cb
        } else {
            bucket.config["baseBranch"].as_str().unwrap_or("main").to_string()
        }
    };
    let wt_path = wt["path"].as_str().unwrap_or("").to_string();
    if wt["isMain"].as_bool().unwrap_or(false) {
        return Ok(json!({ "status": "blocked", "reason": "主工作树不能作为 rebase 来源" }));
    }
    if wt["branch"].as_str() == Some(&base_ref) {
        return Ok(json!({ "status": "blocked", "reason": format!("不能把 {} rebase 到自己", base_ref) }));
    }

    if wt["dirty"].as_bool().unwrap_or(false) {
        let message = input["message"].as_str().unwrap_or("").trim().to_string();
        if message.is_empty() {
            return Ok(json!({
                "status": "blocked", "path": wt_path,
                "reason": "工作树有未提交改动；给 --message \"...\" 自动提交后再 rebase"
            }));
        }
        git::git(Path::new(&wt_path), &["add", "-A"], false)?;
        git::git(Path::new(&wt_path), &["commit", "-m", &message], true)?;
    }
    Ok(perform_rebase(&wt_path, &base_ref))
}

pub fn fanout(base: &str, yes: bool) -> Res<Value> {
    let bucket = get_bucket();
    if !bucket.main.git {
        return Err(blocked(format!("不是 git 仓库: {}", bucket.main.path)));
    }
    let listing = list_worktrees()?;
    let base_ref = if !base.is_empty() {
        base.to_string()
    } else {
        let cb = current_branch(Path::new(&bucket.main.path));
        if !cb.is_empty() {
            cb
        } else {
            bucket.config["baseBranch"].as_str().unwrap_or("main").to_string()
        }
    };

    let worktrees = listing["worktrees"].as_array().cloned().unwrap_or_default();
    let targets: Vec<Value> = worktrees
        .into_iter()
        .filter(|w| {
            !w["isMain"].as_bool().unwrap_or(false)
                && !w["branch"].as_str().unwrap_or("").is_empty()
                && w["branch"].as_str() != Some(&base_ref)
        })
        .collect();
    let plan: Vec<Value> = targets
        .iter()
        .map(|w| {
            let mut blockers: Vec<String> = Vec::new();
            if w["dirty"].as_bool().unwrap_or(false) {
                blockers.push("有未提交改动".into());
            }
            let ahead = w["ahead"].as_u64().unwrap_or(0);
            if w["ahead"].as_u64().map(|a| a > 0).unwrap_or(false) {
                blockers.push(format!("领先 {} {} 个提交", base_ref, ahead));
            }
            json!({
                "name": w["name"], "path": w["path"], "branch": w["branch"],
                "ahead": w["ahead"], "behind": w["behind"],
                "safe": blockers.is_empty(), "blockers": blockers
            })
        })
        .collect();

    let blocked_count = plan.iter().filter(|p| !p["safe"].as_bool().unwrap_or(false)).count();
    if !yes {
        return Ok(json!({ "status": "planned", "base": base_ref, "plan": plan, "blockedCount": blocked_count }));
    }
    if blocked_count > 0 {
        return Ok(json!({ "status": "blocked", "base": base_ref, "plan": plan, "blockedCount": blocked_count }));
    }
    let mut completed: Vec<String> = Vec::new();
    for p in &plan {
        let r = perform_rebase(p["path"].as_str().unwrap_or(""), &base_ref);
        if r["status"].as_str() != Some("ok") {
            let mut out = r;
            out["completed"] = json!(completed);
            out["failedAt"] = p["name"].clone();
            return Ok(out);
        }
        completed.push(p["name"].as_str().unwrap_or("").to_string());
    }
    Ok(json!({ "status": "ok", "base": base_ref, "completed": completed }))
}
