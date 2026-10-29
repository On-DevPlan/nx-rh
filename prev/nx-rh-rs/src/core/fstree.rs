// 文件系统原语：存在性判定、内容摘要、目录树遍历与逐文件差异 —— 与 core/fstree.js 对齐。

use std::collections::BTreeMap;
use std::path::Path;

use md5::{Digest, Md5};

use super::errors::Res;

/// access 判存在（跟随链接）。悬空链接的判定跨平台不一致，
/// 凡是「必须认出悬空链接」的场合用 path_exists。
pub fn exists(p: &Path) -> bool {
    std::fs::metadata(p).is_ok()
}

/// lstat 判存在：不跟随链接，悬空链接也算「存在」。
pub fn path_exists(p: &Path) -> bool {
    std::fs::symlink_metadata(p).is_ok()
}

pub fn md5_of(buf: &[u8]) -> String {
    let mut h = Md5::new();
    h.update(buf);
    hex::encode(h.finalize())
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct FileEntry {
    pub abs: std::path::PathBuf,
    pub md5: String,
    pub size: u64,
}

/// 递归收集目录下所有文件：相对路径（正斜杠）→ { abs, md5, size }。
/// 目录不存在时返回空表（对齐 JS 版 readdir catch 空）。
pub fn walk_files(root: &Path) -> BTreeMap<String, FileEntry> {
    let mut files = BTreeMap::new();
    walk_inner(root, "", &mut files);
    files
}

fn walk_inner(dir: &Path, rel: &str, files: &mut BTreeMap<String, FileEntry>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let abs = e.path();
        let r = if rel.is_empty() { name.clone() } else { format!("{}/{}", rel, name) };
        // 与 JS 版一致：用 metadata（跟随链接）判目录与文件
        let md = match std::fs::metadata(&abs) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if md.is_dir() {
            walk_inner(&abs, &r, files);
        } else if md.is_file() {
            if let Ok(buf) = std::fs::read(&abs) {
                files.insert(r, FileEntry { abs, md5: md5_of(&buf), size: buf.len() as u64 });
            }
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TreeDiff {
    pub file: String,
    pub side: String, // only-central | both-differ | only-project
}

/// 两棵目录树的差异：逐文件 md5 比较。bRoot 不存在时视为空树。
pub fn diff_trees(a_root: &Path, b_root: &Path) -> Vec<TreeDiff> {
    let a = walk_files(a_root);
    let b = walk_files(b_root);
    let mut out = Vec::new();
    for (rel, fa) in &a {
        match b.get(rel) {
            None => out.push(TreeDiff { file: rel.clone(), side: "only-central".into() }),
            Some(fb) if fb.md5 != fa.md5 => {
                out.push(TreeDiff { file: rel.clone(), side: "both-differ".into() })
            }
            _ => {}
        }
    }
    for rel in b.keys() {
        if !a.contains_key(rel) {
            out.push(TreeDiff { file: rel.clone(), side: "only-project".into() });
        }
    }
    out
}

/// 递归拷贝目录（dereference：跟随源内链接，等价 fsp.cp dereference:true）。
pub fn copy_dir_dereference(src: &Path, dst: &Path) -> Res<()> {
    std::fs::create_dir_all(dst).map_err(super::errors::io_err)?;
    let entries = std::fs::read_dir(src).map_err(super::errors::io_err)?;
    for e in entries.flatten() {
        let s = e.path();
        let d = dst.join(e.file_name());
        // metadata 跟随链接：链接按目标内容拷
        let md = std::fs::metadata(&s).map_err(super::errors::io_err)?;
        if md.is_dir() {
            copy_dir_dereference(&s, &d)?;
        } else {
            std::fs::copy(&s, &d).map_err(super::errors::io_err)?;
        }
    }
    Ok(())
}

/// 删除文件或目录树（不存在时静默成功，对齐 rm -rf / force:true）。
pub fn rm_force(p: &Path) {
    if p.is_dir() && !std::fs::symlink_metadata(p).map(|m| m.file_type().is_symlink()).unwrap_or(false) {
        let _ = std::fs::remove_dir_all(p);
    } else {
        let _ = std::fs::remove_file(p);
    }
}
