// 远程拉取原语：git clone / 归档下载到 staging —— 与 skills/svc/remote.js 对齐。
// 只落 staging，由调用方决定取什么；绝不写平台目录。

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;

use crate::core::archive::{read_archive, Limits};
use crate::core::errors::{bad_input, external, not_found, Res};
use crate::core::frontmatter::parse_frontmatter;
use crate::core::paths::{assert_safe_name, remote_skills_dir};
use super::remote_parse::{parse_source, remote_source_id};

pub fn remote_limits() -> (usize, usize, usize, u64) {
    let int = |name: &str, dflt: usize| -> usize {
        std::env::var(name)
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .filter(|v| *v > 0)
            .unwrap_or(dflt)
    };
    (
        int("NX_RH_REMOTE_MAX_BYTES", 10 * 1024 * 1024),
        int("NX_RH_REMOTE_MAX_EXTRACTED", 25 * 1024 * 1024),
        int("NX_RH_REMOTE_MAX_FILES", 1000),
        std::env::var("NX_RH_CLONE_TIMEOUT_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .filter(|v| *v > 0)
            .unwrap_or(300_000),
    )
}

fn is_missing_ref_error(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.contains("couldn't find remote ref") || lower.contains("upload-pack: not our ref")
}

fn is_auth_error(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.contains("authentication failed")
        || lower.contains("permission denied")
        || lower.contains("could not read username")
        || lower.contains("repository not found")
}

fn is_commit_sha(r#ref: &str) -> bool {
    r#ref.len() == 40 && r#ref.chars().all(|c| c.is_ascii_hexdigit())
}

fn run_git(args: &[&str], cwd: Option<&Path>, timeout_ms: u64) -> Res<()> {
    let mut cmd = Command::new("git");
    cmd.args(args);
    if let Some(c) = cwd {
        cmd.current_dir(c);
    }
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GIT_ALLOW_PROTOCOL", "https:http:ssh:git:file");
    cmd.env("GIT_LFS_SKIP_SMUDGE", "1");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(cmd.output());
    });
    let out = match rx.recv_timeout(std::time::Duration::from_millis(timeout_ms)) {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(external(format!("git 失败: {}", e))),
        Err(_) => {
            return Err(external(format!(
                "git 超时（可设 NX_RH_CLONE_TIMEOUT_MS 提额，默认 300000ms）: git {}",
                args.join(" ")
            )))
        }
    };
    if !out.status.success() {
        let message = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let message = if message.is_empty() {
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        } else {
            message
        };
        if is_auth_error(&message) {
            return Err(external(format!(
                "git 认证/权限失败（私有仓库请先配置凭据）: {}",
                message.chars().take(300).collect::<String>()
            )));
        }
        if is_missing_ref_error(&message) {
            return Err(bad_input(format!(
                "远程分支/标签不存在: {}",
                message.chars().take(300).collect::<String>()
            )));
        }
        if message.to_lowercase().contains("timed out") || message.contains("ETIMEDOUT") {
            return Err(external(format!(
                "git 超时（可设 NX_RH_CLONE_TIMEOUT_MS 提额，默认 300000ms）: {}",
                message.chars().take(200).collect::<String>()
            )));
        }
        return Err(external(format!(
            "git 失败（git {}…）: {}",
            args.join(" ").chars().take(80).collect::<String>(),
            message.chars().take(300).collect::<String>()
        )));
    }
    Ok(())
}

fn clone_repo(url: &str, r#ref: &str, target_dir: &Path, timeout_ms: u64) -> Res<()> {
    if r#ref.is_empty() {
        return run_git(&["clone", "--depth", "1", "--", url], Some(&target_dir.to_path_buf()), timeout_ms);
    }
    if !is_commit_sha(r#ref) {
        return run_git(
            &["clone", "--depth", "1", "--branch", r#ref, "--", url],
            Some(&target_dir.to_path_buf()),
            timeout_ms,
        );
    }
    run_git(&["init", "--quiet"], Some(&target_dir.to_path_buf()), timeout_ms)?;
    run_git(&["remote", "add", "origin", url], Some(&target_dir.to_path_buf()), timeout_ms)?;
    if let Err(e) = run_git(&["fetch", "--depth", "1", "origin", r#ref], Some(&target_dir.to_path_buf()), timeout_ms) {
        if e.message.contains("分支/标签不存在") || e.message.contains("allowReachableSHA1InWant") {
            return Err(bad_input(format!(
                "提交 SHA 拉取被服务端拒绝（未开 allowReachableSHA1InWant）: {}",
                r#ref
            )));
        }
        return Err(e);
    }
    run_git(&["checkout", "--quiet", "FETCH_HEAD"], Some(&target_dir.to_path_buf()), timeout_ms)
}

// ─── 直接下载（单 SKILL.md 或 zip/tar.gz 归档）────────────────────

fn download_bytes(url: &str, max_bytes: usize) -> Res<Vec<u8>> {
    // 用 curl（Windows 10+ 自带）+ 手动限额：不引入 HTTP 依赖
    let tmp = std::env::temp_dir().join(format!(
        "nx-rh-rs-dl-{:x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    let out = Command::new("curl")
        .args([
            "-sSL",
            "--max-time",
            "60",
            "--max-filesize",
            &(max_bytes + 1).to_string(),
            "-o",
        ])
        .arg(&tmp)
        .arg("-w")
        .arg("%{http_code}")
        .arg(url)
        .output();
    let Ok(out) = out else {
        return Err(external(format!("下载失败: {}（curl 不可用）", url)));
    };
    let code = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if code != "200" {
        let _ = std::fs::remove_file(&tmp);
        if code == "0" {
            return Err(external(format!(
                "下载失败: {}（{}）",
                url,
                String::from_utf8_lossy(&out.stderr).chars().take(200).collect::<String>()
            )));
        }
        return Err(external(format!("下载失败 HTTP {}: {}", code, url)));
    }
    let buf = std::fs::read(&tmp).unwrap_or_default();
    let _ = std::fs::remove_file(&tmp);
    if buf.len() > max_bytes {
        return Err(bad_input(format!(
            "下载体超过上限 {} 字节，如信任来源可设 NX_RH_REMOTE_MAX_BYTES 覆写",
            max_bytes
        )));
    }
    if buf.is_empty() {
        return Err(bad_input(format!("下载体为空: {}", url)));
    }
    Ok(buf)
}

fn strip_common_root(files: &mut std::collections::BTreeMap<String, Vec<u8>>) {
    let names: Vec<String> = files.keys().cloned().collect();
    if names.is_empty() {
        return;
    }
    let first = names[0].split('/').next().unwrap_or("").to_string();
    if first.is_empty() {
        return;
    }
    if !names.iter().all(|n| n == &first || n.starts_with(&format!("{}/", first))) {
        return;
    }
    let old = std::mem::take(files);
    for (name, data) in old {
        if name == format!("{}/", first) {
            continue;
        }
        let stripped = name[first.len() + 1..].to_string();
        if !stripped.is_empty() {
            files.insert(stripped, data);
        }
    }
}

fn write_files(dir: &Path, files: &std::collections::BTreeMap<String, Vec<u8>>) -> Res<()> {
    for (name, data) in files {
        if name.ends_with('/') {
            continue;
        }
        let target = dir.join(name);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(crate::core::errors::io_err)?;
        }
        std::fs::write(&target, data).map_err(crate::core::errors::io_err)?;
    }
    Ok(())
}

fn skill_name_from_markdown(raw: &str, url: &str) -> String {
    let fm = parse_frontmatter(raw);
    if !fm.name.is_empty() {
        if let Ok(name) = assert_safe_name(&fm.name, "SKILL.md 里的 name") {
            return name;
        }
    }
    let file = url.split('/').next_back().unwrap_or("");
    let file = file
        .strip_suffix(".md")
        .or_else(|| file.strip_suffix(".markdown"))
        .or_else(|| file.strip_suffix(".txt"))
        .unwrap_or(file);
    assert_safe_name(file, "skill 名称").unwrap_or_else(|_| "downloaded-skill".into())
}

fn download_source(url: &str, target_dir: &Path) -> Res<PathBuf> {
    let (max_dl, max_extract, max_files, _) = remote_limits();
    let buf = download_bytes(url, max_dl)?;
    let is_zip = buf.len() >= 4 && &buf[..4] == b"PK\x03\x04";
    let is_gzip = buf.len() >= 2 && buf[0] == 0x1f && buf[1] == 0x8b;
    if is_zip || is_gzip {
        let limits = Limits { max_entries: max_files, max_extracted_bytes: max_extract };
        let mut files = read_archive(&buf, &limits)
            .map_err(|e| bad_input(format!("归档解析失败: {}", e.message)))?;
        strip_common_root(&mut files);
        write_files(target_dir, &files)?;
        return Ok(target_dir.to_path_buf());
    }
    // 非归档：按单个 SKILL.md 处理，包一层以 skill 名命名的目录
    let text = String::from_utf8_lossy(&buf).to_string();
    let name = skill_name_from_markdown(&text, url);
    let dir = target_dir.join(&name);
    std::fs::create_dir_all(&dir).map_err(crate::core::errors::io_err)?;
    std::fs::write(dir.join("SKILL.md"), &buf).map_err(crate::core::errors::io_err)?;
    Ok(target_dir.to_path_buf())
}

/// 解析但不落地：subscribe action 用它分流本地/远程（None = 本地路径）。
pub fn peek_remote(spec: &str) -> Option<Value> {
    match parse_source(spec) {
        Ok(parsed) if parsed["type"] == "local" => None,
        Ok(parsed) => Some(parsed),
        Err(_) => None,
    }
}

pub struct Materialized {
    /// 远程源的稳定 id（用于 staging 目录名与日志）；调用方目前只取目录。
    #[allow(dead_code)]
    pub id: String,
    pub staging: PathBuf,
    pub source_dir: PathBuf,
}

/// 拉取到 staging：远程 Hub 的「导入」与「更新」共用。
pub fn materialize_remote(parsed: &Value) -> Res<Materialized> {
    let id = remote_source_id(parsed)?;
    let base_dir = remote_skills_dir();
    let staging = base_dir.join(format!(".{}.staging", id));
    if staging.exists() {
        crate::core::fstree::rm_force(&staging);
    }
    std::fs::create_dir_all(&base_dir).map_err(crate::core::errors::io_err)?;

    let source_dir: PathBuf;
    let parsed_type = parsed["type"].as_str().unwrap_or("");
    if parsed_type == "git" {
        let url = parsed["url"].as_str().unwrap_or("");
        let r = parsed["ref"].as_str().unwrap_or("");
        let (_, _, _, timeout) = remote_limits();
        clone_repo(url, r, &staging, timeout)?;
        if let Some(subpath) = parsed["subpath"].as_str().filter(|s| !s.is_empty()) {
            let sub = staging.join(subpath);
            if !sub.exists() {
                crate::core::fstree::rm_force(&staging);
                return Err(not_found(format!(
                    "仓库里没有这个子路径: {}（{}）",
                    subpath, url
                )));
            }
            source_dir = sub;
        } else {
            source_dir = staging.clone();
        }
    } else {
        let url = parsed["url"].as_str().unwrap_or("");
        source_dir = download_source(url, &staging)?;
    }
    Ok(Materialized { id, staging, source_dir })
}
