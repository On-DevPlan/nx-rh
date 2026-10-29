// 路径与常量的唯一权威来源 —— 与 JS 版 core/paths.js 对齐。
// 差异点（刻意）：APP_DIR / 配置文件名用 nx-rh-rs，DEFAULT_PORT 用 7801，
// 让两版可以同时启动对比。

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use once_cell::sync::Lazy;

use super::errors::{bad_input, Res};

pub const APP_NAME: &str = "nx-rh-rs";
pub const DEFAULT_PORT: u16 = 7801;

// 家目录下的配置目录（对应 JS 版 ~/.nx-rh）
pub fn home_dir() -> PathBuf {
    // Windows: %USERPROFILE%；POSIX: $HOME
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

pub fn app_dir() -> PathBuf {
    home_dir().join(".nx-rh-rs")
}

pub fn store_path() -> PathBuf {
    app_dir().join("store.json")
}

pub fn env_snapshot_dir() -> PathBuf {
    app_dir().join("env_snapshots")
}

// 远程拉取的暂存区（测试用 NX_RH_REMOTE_DIR 覆盖）
pub fn remote_skills_dir() -> PathBuf {
    std::env::var("NX_RH_REMOTE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| app_dir().join(".staging"))
}

// 远程订阅仓库（NX_RH_REMOTE_REPO_DIR 覆盖）
pub fn remote_repo_dir() -> PathBuf {
    std::env::var("NX_RH_REMOTE_REPO_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| app_dir().join("远程订阅"))
}

// 存储位置：NX_RH_STORE 环境变量优先
pub fn store_path_from_env() -> PathBuf {
    std::env::var("NX_RH_STORE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| store_path())
}

// ─── 启动目录（项目根）注入 ────────────────────────────────────────
// 优先级：请求作用域（scope，对应 ALS）> set_startup_dir（serve <dir>）
//        > NX_RH_CWD 环境变量 > 进程 cwd。

static STARTUP_DIR: Lazy<Mutex<Option<PathBuf>>> = Lazy::new(|| Mutex::new(None));

pub fn set_startup_dir(dir: Option<&Path>) {
    let resolved = dir.map(|d| absolutize(d));
    *STARTUP_DIR.lock().unwrap() = resolved;
}

pub fn startup_dir_path() -> Option<PathBuf> {
    STARTUP_DIR.lock().unwrap().clone()
}

// 当前项目根：线程局部作用域优先，其次启动目录，其次 NX_RH_CWD，最后 cwd。
// （HTTP 层在每个请求线程上写入 SCOPE，等价于 JS 版的 AsyncLocalStorage。）
thread_local! {
    static SCOPE: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
}

pub fn set_scope(dir: &Path) {
    SCOPE.with(|s| *s.borrow_mut() = Some(absolutize(dir)));
}

pub fn clear_scope() {
    SCOPE.with(|s| *s.borrow_mut() = None);
}

pub fn project_root() -> PathBuf {
    let sc = SCOPE.with(|s| s.borrow().clone());
    if let Some(dir) = sc {
        return dir;
    }
    if let Some(dir) = startup_dir_path() {
        return dir;
    }
    if let Ok(cwd) = std::env::var("NX_RH_CWD") {
        return PathBuf::from(cwd);
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

/// 路径的跨平台归一形式（桶键）：Windows 折叠大小写，分隔符统一为 `\`。
pub fn cwd_scope(dir: Option<&Path>) -> String {
    let abs = absolutize(dir.unwrap_or(&project_root()));
    let s = abs.to_string_lossy().replace('/', "\\");
    if cfg!(windows) { s.to_lowercase() } else { s }
}

/// 相对路径 → 绝对路径（基于 cwd），不做磁盘访问。
pub fn absolutize(p: &Path) -> PathBuf {
    if p.is_absolute() {
        normalize_abs(p)
    } else {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        normalize_abs(&cwd.join(p))
    }
}

/// 折叠 `.` 与 `..` 段（纯词法，不动文件系统）。
pub fn normalize_abs(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            c => out.push(c.as_os_str()),
        }
    }
    out
}

/// 名称安全校验：拒绝路径穿越。用于「这个字符串会被用作**目录名**」的场景。
/// 拒绝前导点与分隔符；中文等合法命名照常通过。
pub fn assert_safe_name(name: &str, label: &str) -> Res<String> {
    let has_sep = name.contains('/') || name.contains('\\');
    if name.is_empty()
        || has_sep
        || name.contains("..")
        || name.starts_with('.')
        || name != name.trim()
    {
        return Err(bad_input(format!("非法 {}: {}", label, name)));
    }
    Ok(name.to_string())
}

/// 相对路径校验：外部给的「某目录内的文件路径」都要过这里。
/// 允许子目录与前导点（.gitignore 是正常文件）；拒绝绝对路径与 `..` 段。
/// 返回归一化后的正斜杠路径。
pub fn assert_safe_rel_path(input: &str, label: &str, allow_subdir: bool) -> Res<String> {
    if input.is_empty() {
        return Err(bad_input(format!("{}不能为空", label)));
    }
    if input.starts_with('/')
        || input.starts_with('\\')
        || (input.len() >= 2 && input.as_bytes()[1] == b':' && input.as_bytes()[0].is_ascii_alphabetic())
    {
        return Err(bad_input(format!("{}必须是相对路径: {}", label, input)));
    }
    let segments: Vec<&str> = input
        .split(['/', '\\'])
        .filter(|s| !s.is_empty() && *s != ".")
        .collect();
    if segments.is_empty() {
        return Err(bad_input(format!("非法 {}: {}", label, input)));
    }
    if segments.iter().any(|s| *s == "..") {
        return Err(bad_input(format!("{}不得包含 ..: {}", label, input)));
    }
    if !allow_subdir && segments.len() > 1 {
        return Err(bad_input(format!("{}不能包含路径分隔符: {}", label, input)));
    }
    Ok(segments.join("/"))
}

/// 绝对路径判定（不访问磁盘）：`/x`、`\\x`、`C:/x`。
pub fn is_abs_str(p: &str) -> bool {
    p.starts_with('/')
        || p.starts_with('\\')
        || (p.len() >= 2 && p.as_bytes()[1] == b':' && p.as_bytes()[0].is_ascii_alphabetic())
}
