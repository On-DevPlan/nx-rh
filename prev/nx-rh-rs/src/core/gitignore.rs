// .gitignore 纯解析：不碰文件系统 —— 与 core/gitignore.js 对齐。
// 完整匹配仍以 git 自身（check-ignore / ls-files）为准。

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct IgnoreEntry {
    pub raw: String,
    pub negated: bool,
    pub dir_only: bool,
    pub root_anchored: bool,
    pub has_glob: bool,
    pub path: String,
}

fn has_glob_token(line: &str) -> bool {
    let bytes = line.as_bytes();
    for i in 0..bytes.len() {
        if matches!(bytes[i], b'*' | b'?' | b'[') {
            if i > 0 && bytes[i - 1] == b'\\' {
                continue;
            }
            return true;
        }
    }
    false
}

pub fn parse_gitignore(text: &str) -> Vec<IgnoreEntry> {
    let mut entries = Vec::new();
    for raw_line in text.lines() {
        let mut line = raw_line.trim().to_string();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let negated = line.starts_with('!');
        if negated {
            line = line[1..].to_string();
        }
        let dir_only = line.ends_with('/');
        if dir_only {
            line.pop();
        }
        let leading_slash = line.starts_with('/');
        if leading_slash {
            line = line[1..].to_string();
        }
        let glob = has_glob_token(&line);
        // 去掉转义符（\# \* 等）
        let clean = line
            .chars()
            .fold(String::new(), |acc, c| {
                if acc.ends_with('\\') {
                    format!("{}{}", &acc[..acc.len() - 1], c)
                } else {
                    format!("{}{}", acc, c)
                }
            });
        let segments: Vec<&str> = clean.split('/').filter(|s| !s.is_empty()).collect();
        entries.push(IgnoreEntry {
            raw: raw_line.to_string(),
            negated,
            dir_only,
            root_anchored: leading_slash || clean.contains('/'),
            has_glob: glob,
            path: segments.join("/"),
        });
    }
    entries
}

/// 可直接落全路径的条目：非取反、无 glob、有路径。
pub fn concrete_entries(entries: &[IgnoreEntry]) -> Vec<&IgnoreEntry> {
    entries
        .iter()
        .filter(|e| !e.negated && !e.has_glob && !e.path.is_empty())
        .collect()
}

/// 归一的对比键：忽略前后斜杠差异。
pub fn ignore_key(p: &str) -> String {
    p.replace('\\', "/").trim_matches('/').to_string()
}
