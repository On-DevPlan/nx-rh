// 远程源规格解析 —— 与 skills/svc/remote-parse.js 对齐。
// 移植自 vercel-labs/skills（MIT），按本仓库需要裁剪。

use serde_json::{json, Value};

use crate::core::errors::{bad_input, Res};
use crate::core::paths::{absolutize, is_abs_str};

pub fn sanitize_subpath(subpath: &str) -> Res<String> {
    for segment in subpath.replace('\\', "/").split('/') {
        if segment == ".." {
            return Err(bad_input(format!("不安全的子路径: {}（不得包含 ..）", subpath)));
        }
    }
    Ok(subpath.to_string())
}

fn is_local_path(input: &str) -> bool {
    is_abs_str(input)
        || input.starts_with("./")
        || input.starts_with("../")
        || input == "."
        || input == ".."
}

fn looks_like_git_source(input: &str) -> bool {
    input.starts_with("git@")
        || input.starts_with("ssh://")
        || input.starts_with("file://")
        || {
            let lower = input.to_lowercase();
            lower.starts_with("https://")
                && lower.rsplit('.').next() == Some("git")
        }
        || input.to_lowercase().starts_with("http://")
            && input.to_lowercase().ends_with(".git")
        || input.starts_with("github.com/")
        || input.starts_with("gitlab.com/")
        || (!input.contains(':')
            && !input.starts_with('.')
            && !input.starts_with('/')
            && regex_lite_owner_repo(input))
}

fn regex_lite_owner_repo(input: &str) -> bool {
    // ^([^/]+)\/([^/]+)(\/.*)?$
    let mut parts = input.splitn(3, '/');
    let a = parts.next();
    let b = parts.next();
    match (a, b) {
        (Some(a), Some(b)) if !a.is_empty() && !b.is_empty() => true,
        _ => false,
    }
}

fn parse_fragment_ref(input: &str) -> (String, Option<String>) {
    match input.find('#') {
        None => (input.to_string(), None),
        Some(hash_index) => {
            let without = &input[..hash_index];
            let fragment = &input[hash_index + 1..];
            if fragment.is_empty() || !looks_like_git_source(without) {
                (input.to_string(), None)
            } else {
                (without.to_string(), Some(fragment.to_string()))
            }
        }
    }
}

fn is_hosted_artifact_url(input: &str) -> bool {
    let Ok(parsed) = url::Url::parse(input) else {
        return false;
    };
    let host = parsed.host_str().unwrap_or("").to_lowercase();
    let path = parsed.path();
    match host.as_str() {
        "raw.githubusercontent.com" | "codeload.github.com" | "objects.githubusercontent.com" => true,
        "github.com" => {
            let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
            if segs.len() < 3 {
                return false;
            }
            matches!(segs[2], "archive" | "raw") || (segs[2] == "releases" && (segs.len() > 3 && (segs[3] == "download" || segs[3] == "latest")))
        }
        "gitlab.com" => path.contains("/-/archive/") || path.contains("/-/raw/"),
        _ => false,
    }
}

/// 解析远程源规格 → { type, url, ref?, subpath?, localPath? }。
pub fn parse_source(input: &str) -> Res<Value> {
    let input = input.trim();
    if input.is_empty() {
        return Err(bad_input("源规格不能为空"));
    }

    if is_local_path(input) {
        let resolved = absolutize(std::path::Path::new(input)).to_string_lossy().to_string();
        return Ok(json!({ "type": "local", "url": resolved, "localPath": resolved }));
    }

    if let Some(rest) = input.strip_prefix("file://") {
        return match rest.find('#') {
            None => Ok(json!({ "type": "git", "url": input })),
            Some(hash) => Ok(json!({
                "type": "git",
                "url": format!("file://{}", &rest[..hash]),
                "ref": &rest[hash + 1..]
            })),
        };
    }

    let (input_wo, fragment_ref) = parse_fragment_ref(input);
    let input: &str = &input_wo;

    if let Some(rest) = input.strip_prefix("github:") {
        let spec = match &fragment_ref {
            Some(r) => format!("{}#{}", rest, r),
            None => rest.to_string(),
        };
        return parse_source(&spec);
    }
    if let Some(rest) = input.strip_prefix("gitlab:") {
        let spec = match &fragment_ref {
            Some(r) => format!("https://gitlab.com/{}#{}", rest, r),
            None => format!("https://gitlab.com/{}", rest),
        };
        return parse_source(&spec);
    }

    if is_hosted_artifact_url(input) {
        return Ok(json!({ "type": "download", "url": input }));
    }

    // GitHub URL 带子路径
    if let Some(_caps) = regex_match(input, "github.com/", "/tree/") {
        // github.com/owner/repo/tree/ref/subpath
        let rest = &input["https://".len().min(input.len()).min(input.find("github.com/").unwrap_or(0))..];
        let _ = rest;
        let start = input.find("github.com/").unwrap();
        let after = &input[start + "github.com/".len()..];
        let segs: Vec<&str> = after.split('/').collect();
        if segs.len() >= 5 {
            let owner = segs[0];
            let repo = segs[1].trim_end_matches(".git");
            let r = segs[3];
            let subpath = segs[4..].join("/").trim_end_matches('/').to_string();
            let subpath = sanitize_subpath(&subpath)?;
            return Ok(json!({
                "type": "git",
                "url": format!("https://github.com/{}/{}.git", owner, repo),
                "ref": fragment_ref.clone().unwrap_or_else(|| r.to_string()),
                "subpath": subpath,
            }));
        }
    }

    // GitHub URL 只带分支：.../owner/repo/tree/branch
    if let Some(pos) = input.find("github.com/") {
        let after = &input[pos + "github.com/".len()..];
        let segs: Vec<&str> = after.split('/').collect();
        if segs.len() == 4 && segs[2] == "tree" {
            return Ok(json!({
                "type": "git",
                "url": format!("https://github.com/{}/{}.git", segs[0], segs[1].trim_end_matches(".git")),
                "ref": fragment_ref.clone().unwrap_or_else(|| segs[3].to_string()),
            }));
        }
        // GitHub 仓库 URL：.../owner/repo
        if segs.len() == 2 && (input.starts_with("http://") || input.starts_with("https://")) {
            let mut v = json!({
                "type": "git",
                "url": format!("https://github.com/{}/{}.git", segs[0], segs[1].trim_end_matches(".git")),
            });
            if let Some(r) = &fragment_ref {
                v["ref"] = json!(r);
            }
            return Ok(v);
        }
    }

    // GitLab URL 带子路径（/-/tree/branch/path）
    if input.contains("/-/tree/") {
        if let Some(tree_pos) = input.find("/-/tree/") {
            let (prefix, suffix) = input.split_at(tree_pos);
            let suffix = &suffix["/-/tree/".len()..];
            let mut suffix_segs = suffix.splitn(2, '/');
            let r = suffix_segs.next().unwrap_or("");
            let subpath = suffix_segs.next().unwrap_or("");
            if let Some(rest) = input.strip_prefix("http://").or_else(|| input.strip_prefix("https://")) {
                let _ = rest;
            }
            let protocol = if input.starts_with("https://") { "https" } else { "http" };
            let host_part = prefix
                .trim_start_matches("https://")
                .trim_start_matches("http://");
            let (hostname, repo_path) = match host_part.split_once('/') {
                Some((h, p)) => (h.to_string(), p.to_string()),
                None => (host_part.to_string(), String::new()),
            };
            if hostname != "github.com" && !repo_path.is_empty() {
                let mut v = json!({
                    "type": "git",
                    "url": format!("{}://{}/{}.git", protocol, hostname, repo_path.trim_end_matches(".git")),
                    "ref": fragment_ref.clone().unwrap_or_else(|| r.to_string()),
                });
                if !subpath.is_empty() {
                    v["subpath"] = json!(sanitize_subpath(subpath.trim_end_matches('/'))?);
                }
                return Ok(v);
            }
        }
    }

    // gitlab.com 仓库（支持嵌套子组）
    if input.starts_with("https://gitlab.com/") || input.starts_with("http://gitlab.com/") {
        let path = input
            .trim_start_matches("https://gitlab.com/")
            .trim_start_matches("http://gitlab.com/")
            .trim_end_matches('/')
            .trim_end_matches(".git");
        if path.contains('/') {
            let mut v = json!({
                "type": "git",
                "url": format!("https://gitlab.com/{}.git", path),
            });
            if let Some(r) = &fragment_ref {
                v["ref"] = json!(r);
            }
            return Ok(v);
        }
    }

    // owner/repo 简写（可带 /子路径），默认 GitHub
    if !input.contains(':') && !input.starts_with('.') && !input.starts_with('/') {
        let segs: Vec<&str> = input.split('/').filter(|s| !s.is_empty()).collect();
        if segs.len() >= 2 {
            let mut v = json!({
                "type": "git",
                "url": format!("https://github.com/{}/{}.git", segs[0], segs[1].trim_end_matches(".git")),
            });
            if let Some(r) = &fragment_ref {
                v["ref"] = json!(r);
            }
            if segs.len() > 2 {
                v["subpath"] = json!(sanitize_subpath(&segs[2..].join("/"))?);
            }
            return Ok(v);
        }
    }

    // git@ SSH 与 ssh://
    if input.starts_with("git@") || input.starts_with("ssh://") {
        let mut v = json!({ "type": "git", "url": input });
        if let Some(r) = &fragment_ref {
            v["ref"] = json!(r);
        }
        return Ok(v);
    }

    // 其它 .git 结尾的 http(s) URL
    let lower = input.to_lowercase();
    if (input.starts_with("http://") || input.starts_with("https://"))
        && (lower.ends_with(".git")
            || lower.contains(".git/")
            || lower.contains(".git?")
            || lower.contains(".git#"))
    {
        let mut v = json!({ "type": "git", "url": input });
        if let Some(r) = &fragment_ref {
            v["ref"] = json!(r);
        }
        return Ok(v);
    }

    if input.starts_with("http://") || input.starts_with("https://") {
        return Ok(json!({ "type": "download", "url": input }));
    }

    Err(bad_input(format!(
        "无法识别的源规格: {}（支持本地路径、owner/repo、git URL、归档 URL）",
        input
    )))
}

/// 极简「前缀包含」匹配（替代 regex crate 的两次 github tree 判定）
fn regex_match(input: &str, _a: &str, _b: &str) -> Option<()> {
    if input.contains("github.com/") && input.contains("/tree/") {
        Some(())
    } else {
        None
    }
}

/// 源标识 → 落地目录名：host--owner--repo[--子路径]。
pub fn remote_source_id(parsed: &Value) -> Res<String> {
    let url = parsed.get("url").and_then(|u| u.as_str()).unwrap_or("");
    let base: String;
    if parsed.get("type").and_then(|t| t.as_str()) == Some("download") {
        if let Ok(u) = url::Url::parse(url) {
            let host = u.host_str().unwrap_or("");
            let path = u.path().trim_end_matches('/');
            base = format!("{}{}", host, path);
        } else {
            base = url.to_string();
        }
    } else if url.starts_with("git@") {
        // git@host:owner/repo.git
        let rest = &url[4..];
        match rest.split_once(':') {
            Some((host, repo)) => {
                base = format!("{}/{}", host, repo.trim_end_matches(".git"));
            }
            None => base = url.to_string(),
        }
    } else if let Ok(u) = url::Url::parse(url) {
        let host = u.host_str().unwrap_or("");
        let path = u.path().trim_start_matches('/').trim_end_matches(".git").trim_end_matches('/');
        base = format!("{}/{}", host, path);
    } else {
        base = url.to_string();
    }

    let cleaned: String = base
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '/',
            other => other,
        })
        .collect();
    let mut id: String = cleaned
        .split('/')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("--");

    if let Some(subpath) = parsed.get("subpath").and_then(|s| s.as_str()) {
        let sub: String = subpath
            .chars()
            .map(|c| match c {
                '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => "--".into(),
                other => other.to_string(),
            })
            .collect();
        id.push_str(&format!("--{}", sub));
    }
    if id.len() > 80 {
        id = id.chars().take(80).collect();
    }
    if id.is_empty() {
        return Err(bad_input(format!("无法从源推导目录名: {}", url)));
    }
    Ok(id)
}
