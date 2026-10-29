// git 原语：执行 git 子进程 + worktree porcelain 的纯解析 —— 与 core/git.js 对齐。

use std::path::Path;
use std::process::Command;

use super::errors::{external, Res};

pub struct GitOut {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// 同步执行 git。allow_fail：非零退出不报错（rebase 冲突等业务分支由调用方判读）。
pub fn git(cwd: &Path, args: &[&str], allow_fail: bool) -> Res<GitOut> {
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(cwd);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let out = cmd.output().map_err(|e| external(format!("无法执行 git（{}）: {}", args.join(" "), e)))?;
    let code = out.status.code().unwrap_or(0);
    if code != 0 && !allow_fail {
        let detail = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let detail = if detail.is_empty() {
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        } else {
            detail
        };
        let detail = if detail.is_empty() { format!("退出码 {}", code) } else { detail };
        return Err(external(format!("git {} 失败: {}", args.join(" "), detail)));
    }
    Ok(GitOut {
        code,
        stdout: String::from_utf8_lossy(&out.stdout).to_string(),
        stderr: String::from_utf8_lossy(&out.stderr).to_string(),
    })
}

pub fn rev_parse(cwd: &Path, what: &str) -> Res<String> {
    Ok(git(cwd, &["rev-parse", what], false)?.stdout.trim().to_string())
}

pub fn is_work_tree(cwd: &Path) -> bool {
    matches!(git(cwd, &["rev-parse", "--is-inside-work-tree"], true), Ok(r) if r.code == 0 && r.stdout.trim() == "true")
}

pub fn top_level(cwd: &Path) -> Option<String> {
    git(cwd, &["rev-parse", "--show-toplevel"], true)
        .ok()
        .filter(|r| r.code == 0)
        .map(|r| r.stdout.trim().to_string())
}

pub fn git_common_dir(cwd: &Path) -> Option<String> {
    git(cwd, &["rev-parse", "--git-common-dir"], true)
        .ok()
        .filter(|r| r.code == 0)
        .map(|r| r.stdout.trim().to_string())
}

pub fn current_branch(cwd: &Path) -> String {
    git(cwd, &["branch", "--show-current"], true)
        .map(|r| r.stdout.trim().to_string())
        .unwrap_or_default()
}

pub fn is_dirty(cwd: &Path) -> bool {
    matches!(git(cwd, &["status", "--porcelain"], true), Ok(r) if r.code == 0 && !r.stdout.trim().is_empty())
}

/// check-ignore：0=被忽略，1=未被忽略，128=出错
pub fn check_ignore(cwd: &Path, abs_path: &str) -> i32 {
    git(cwd, &["check-ignore", abs_path], true).map(|r| r.code).unwrap_or(128)
}

pub fn branch_exists(cwd: &Path, branch: &str) -> bool {
    matches!(
        git(cwd, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{}", branch)], true),
        Ok(r) if r.code == 0
    )
}

pub struct AheadBehind {
    pub ahead: Option<u64>,
    pub behind: Option<u64>,
}

pub fn ahead_behind(cwd: &Path, r#ref: &str) -> AheadBehind {
    let a = git(cwd, &["rev-list", "--count", &format!("{}..HEAD", r#ref)], true);
    let Ok(a) = a else {
        return AheadBehind { ahead: None, behind: None };
    };
    if a.code != 0 {
        return AheadBehind { ahead: None, behind: None };
    }
    let b = git(cwd, &["rev-list", "--count", &format!("HEAD..{}", r#ref)], true);
    AheadBehind {
        ahead: Some(a.stdout.trim().parse().unwrap_or(0)),
        behind: b.ok().filter(|x| x.code == 0).map(|x| x.stdout.trim().parse().unwrap_or(0)),
    }
}

pub fn worktree_porcelain(cwd: &Path) -> Res<String> {
    Ok(git(cwd, &["worktree", "list", "--porcelain"], false)?.stdout)
}

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct WorktreeRecord {
    pub path: String,
    pub head: String,
    pub branch: Option<String>,
    pub detached: bool,
    pub bare: bool,
    pub locked: bool,
}

/// 纯函数：解析 `git worktree list --porcelain`。
pub fn parse_worktree_porcelain(text: &str) -> Vec<WorktreeRecord> {
    let mut out = Vec::new();
    let mut cur: Option<WorktreeRecord> = None;
    for raw_line in text.lines() {
        let line = raw_line.trim_end();
        if line.trim().is_empty() {
            if let Some(c) = cur.take() {
                if !c.path.is_empty() {
                    out.push(c);
                }
            }
            continue;
        }
        let rec = cur.get_or_insert_with(WorktreeRecord::default);
        if let Some(p) = line.strip_prefix("worktree ") {
            rec.path = p.to_string();
        } else if let Some(h) = line.strip_prefix("HEAD ") {
            rec.head = h.to_string();
        } else if let Some(b) = line.strip_prefix("branch refs/heads/") {
            rec.branch = Some(b.to_string());
        } else if line == "detached" {
            rec.detached = true;
        } else if line == "bare" {
            rec.bare = true;
        } else if line == "locked" || line.starts_with("locked ") {
            rec.locked = true;
        }
    }
    if let Some(c) = cur.take() {
        if !c.path.is_empty() {
            out.push(c);
        }
    }
    out
}
