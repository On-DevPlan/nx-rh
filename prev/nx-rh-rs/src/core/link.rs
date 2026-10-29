// 目录链接的创建与识别 —— 与 core/link.js 对齐。
// Windows 用 junction（不需要开发者模式/管理员）；POSIX 用相对 symlink。

use super::paths::CowStrExt;
use std::path::{Path, PathBuf};

use super::paths::absolutize;

/// 路径等价判定：Windows 大小写不敏感。纯字面量比较，不做 realpath。
pub fn same_path(a: &str, b: &str) -> bool {
    if a.is_empty() || b.is_empty() {
        return false;
    }
    let na = absolutize(Path::new(a)).to_string_lossy().native();
    let nb = absolutize(Path::new(b)).to_string_lossy().native();
    if cfg!(windows) {
        na.eq_ignore_ascii_case(&nb)
    } else {
        na == nb
    }
}

fn realpath_lossy(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

/// 比较两个路径是否指向同一实体：先各自 realpath 再比。
/// 不存在时退回字面量比较（此时判为不同是正确的）。
pub fn same_real_path(a: &str, b: &str) -> bool {
    if a.is_empty() || b.is_empty() {
        return false;
    }
    let ra = realpath_lossy(Path::new(a));
    let rb = realpath_lossy(Path::new(b));
    let sa = ra.to_string_lossy().native();
    let sb = rb.to_string_lossy().native();
    if cfg!(windows) {
        sa.eq_ignore_ascii_case(&sb)
    } else {
        sa == sb
    }
}

/// 父目录本身是软链时，解析出「真实父目录 + 原文件名」。
fn resolve_parent_symlinks(p: &Path) -> PathBuf {
    let abs = absolutize(p);
    match abs.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => {
            let real = std::fs::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf());
            real.join(abs.file_name().unwrap_or_default())
        }
        _ => abs,
    }
}

/// 链接类型检测：symlink / junction（Windows）。
/// 返回 ''（无链接）、'symlink' 或 'junction'。
pub fn detect_link_type(p: &Path) -> String {
    let Ok(lm) = std::fs::symlink_metadata(p) else {
        return String::new();
    };
    if lm.file_type().is_symlink() {
        return "symlink".into();
    }
    // junction：Windows 上 symlink_metadata 看到的是目录。通过 canonicalize 后
    // 路径发生变化来识别（junction 目标 ≠ 自身字面量）。
    if cfg!(windows) && lm.is_dir() {
        if let (Some(meta), Ok(real)) = (p.file_name(), std::fs::canonicalize(p)) {
            let _ = meta;
            let self_norm = absolutize(p).to_string_lossy().native().to_lowercase();
            let real_norm = real.to_string_lossy().native().to_lowercase();
            if self_norm != real_norm {
                return "junction".into();
            }
        }
    }
    String::new()
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub already: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 建立目录链接。失败不 panic，返回 ok:false 由调用方决定降级复制。
pub fn create_skill_link(target: &Path, link_path: &Path) -> LinkResult {
    let abs_t = absolutize(target);
    let abs_l = absolutize(link_path);

    // 防自指：双方 realpath 相同视为已就绪
    if same_real_path(
        &abs_t.to_string_lossy(),
        &abs_l.to_string_lossy(),
    ) {
        return LinkResult { ok: true, link_type: None, already: Some(true), error: None };
    }

    let real_t = resolve_parent_symlinks(&abs_t);
    let real_l = resolve_parent_symlinks(&abs_l);
    if same_real_path(&real_t.to_string_lossy(), &real_l.to_string_lossy()) {
        return LinkResult { ok: true, link_type: None, already: Some(true), error: None };
    }

    // 清理旧目标：链接只删本体，实体目录递归删除
    match std::fs::symlink_metadata(&abs_l) {
        Ok(md) => {
            if md.file_type().is_symlink() {
                let _ = std::fs::remove_file(&abs_l);
            } else {
                super::fstree::rm_force(&abs_l);
            }
        }
        Err(_) => {}
    }

    if let Some(parent) = abs_l.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return LinkResult { ok: false, link_type: None, already: None, error: Some(e.to_string()) };
        }
    }

    #[cfg(windows)]
    {
        // junction：要求绝对目标，不需要特权
        match junction_create(&real_t, &abs_l) {
            Ok(()) => LinkResult { ok: true, link_type: Some("junction".into()), already: None, error: None },
            Err(e) => LinkResult { ok: false, link_type: None, already: None, error: Some(e) },
        }
    }
    #[cfg(not(windows))]
    {
        // POSIX：相对目标，整目录搬迁后链接仍有效
        let from = resolve_parent_symlinks(abs_l.parent().unwrap_or(Path::new("/")));
        let rel = pathdiff(&from, &real_t);
        match std::os::unix::fs::symlink(&rel, &abs_l) {
            Ok(()) => LinkResult { ok: true, link_type: Some("symlink".into()), already: None, error: None },
            Err(e) => LinkResult { ok: false, link_type: None, already: None, error: Some(e.to_string()) },
        }
    }
}

#[cfg(windows)]
fn junction_create(target: &Path, link: &Path) -> Result<(), String> {
    // 直接调 mklink /J：Windows 上无特权的目录链接标准做法
    let out = std::process::Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output();
    match out {
        Ok(o) if o.status.success() => Ok(()),
        Ok(o) => Err(String::from_utf8_lossy(&o.stderr).trim().to_string()),
        Err(e) => Err(e.to_string()),
    }
}


#[cfg(windows)]
trait CreateNoWindow {
    fn creation_flags(&mut self, flags: u32) -> &mut Self;
}

#[cfg(windows)]
impl CreateNoWindow for std::process::Command {
    fn creation_flags(&mut self, flags: u32) -> &mut Self {
        std::os::windows::process::CommandExt::creation_flags(self, flags)
    }
}

/// 读取链接目标（symlink 或 junction）。失败返回空串。
#[allow(dead_code)]
pub fn read_link(p: &Path) -> PathBuf {
    std::fs::read_link(p).unwrap_or_default()
}

// POSIX 相对路径计算（供 symlink 相对目标用）
#[cfg(not(windows))]
fn pathdiff(from: &Path, to: &Path) -> PathBuf {
    pathdiff_diff_paths(to, from).unwrap_or_else(|| to.to_path_buf())
}

#[cfg(not(windows))]
fn pathdiff_diff_paths(path: &Path, base: &Path) -> Option<PathBuf> {
    use std::path::Component;
    if path.is_absolute() != base.is_absolute() {
        return if path.is_absolute() { Some(path.to_path_buf()) } else { None };
    }
    let mut ita = path.components();
    let mut itb = base.components();
    let mut comps: Vec<Component> = vec![];
    loop {
        match (ita.next(), itb.next()) {
            (None, None) => break,
            (Some(a), None) => {
                comps.push(a);
                comps.extend(ita.by_ref());
                break;
            }
            (None, _) => comps.push(Component::ParentDir),
            (Some(a), Some(b)) if comps.is_empty() && a == b => {}
            (Some(a), Some(b)) if b == Component::CurDir => comps.push(a),
            (Some(_), Some(b)) if b == Component::ParentDir => return None,
            (Some(a), Some(_)) => {
                comps.push(Component::ParentDir);
                for _ in itb {
                    comps.push(Component::ParentDir);
                }
                comps.push(a);
                comps.extend(ita.by_ref());
                break;
            }
        }
    }
    Some(comps.iter().map(|c| c.as_os_str()).collect())
}
