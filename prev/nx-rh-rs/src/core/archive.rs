// 归档解包（zip / tar.gz）—— 与 core/archive.js 对齐。
// zip: 自写 central-directory 读取器（stored/deflate）；tar: ustar 512 字节块。
// 安全边界：maxEntries / maxExtractedBytes 超限报错；路径过 normalize_archive_path；
// 拒绝加密条目与链接条目。

use std::collections::BTreeMap;

use super::errors::{bad_input, AppError, Res};
use flate2::read::MultiGzDecoder;
use std::io::Read;

pub struct Limits {
    pub max_entries: usize,
    pub max_extracted_bytes: usize,
}

fn validation(msg: impl Into<String>) -> AppError {
    super::errors::app_error(super::errors::INTERNAL, msg.into())
}

/// 条目路径白名单化：拒绝绝对路径、盘符、.. 穿越与 NUL。
pub fn normalize_archive_path(raw: &str) -> Option<String> {
    if raw.is_empty() || raw.contains('\0') {
        return None;
    }
    let path = raw.replace('\\', "/");
    if path.starts_with('/') || (path.len() >= 2 && path.as_bytes()[1] == b':' && path.as_bytes()[0].is_ascii_alphabetic()) {
        return None;
    }
    let parts: Vec<&str> = path.split('/').collect();
    if parts.iter().any(|p| *p == "..") {
        return None;
    }
    let normalized: Vec<&str> = parts.into_iter().filter(|p| !p.is_empty() && *p != ".").collect();
    let joined = normalized.join("/");
    if joined.is_empty() && !path.ends_with('/') {
        return None;
    }
    if path.ends_with('/') && !joined.is_empty() {
        Some(format!("{}/", joined))
    } else {
        Some(joined)
    }
}

// ─── zip ──────────────────────────────────────────────────────────────

const EOCD_SIG: u32 = 0x06054b50;
const CDH_SIG: u32 = 0x02014b50;
const LFH_SIG: u32 = 0x04034b50;

fn u16(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([b[o], b[o + 1]])
}
fn u32(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}

pub fn read_zip_archive(bytes: &[u8], limits: &Limits) -> Res<BTreeMap<String, Vec<u8>>> {
    let b = bytes;
    // 找 End Of Central Directory（从尾部往前扫，最多 64KB+22）
    let mut eocd = None;
    let min = b.len().saturating_sub(0xffff + 22);
    let mut o = b.len().checked_sub(22).ok_or_else(|| validation("Invalid zip archive"))?;
    loop {
        if u32(b, o) == EOCD_SIG {
            let comment_len = u16(b, o + 20) as usize;
            if o + 22 + comment_len == b.len() {
                eocd = Some(o);
                break;
            }
        }
        if o == min {
            break;
        }
        o -= 1;
    }
    let Some(eocd) = eocd else {
        return Err(validation("Invalid zip archive"));
    };

    let total_entries = u16(b, eocd + 10) as usize;
    if total_entries > limits.max_entries {
        return Err(validation(format!(
            "Archive contains too many files ({}). Maximum is {}.",
            total_entries, limits.max_entries
        )));
    }
    let mut offset = u32(b, eocd + 16) as usize;
    let cd_size = u32(b, eocd + 12) as usize;
    if offset + cd_size > eocd {
        return Err(validation("Invalid zip archive: central directory overlaps archive trailer"));
    }

    let mut files = BTreeMap::new();
    let mut extracted: usize = 0;
    for _ in 0..total_entries {
        if o32(b, offset) != CDH_SIG {
            return Err(validation("Invalid zip central directory entry"));
        }
        let flags = u16(b, offset + 8);
        let method = u16(b, offset + 10);
        let crc_expected = u32(b, offset + 16);
        let compressed_size = u32(b, offset + 20) as usize;
        let uncompressed_size = u32(b, offset + 24) as usize;
        let name_len = u16(b, offset + 28) as usize;
        let extra_len = u16(b, offset + 30) as usize;
        let comment_len = u16(b, offset + 32) as usize;
        let external_attrs = u32(b, offset + 38);
        let local_offset = u32(b, offset + 42) as usize;

        let name_start = offset + 46;
        if name_start + name_len > b.len() {
            return Err(validation("Invalid zip central directory entry data"));
        }
        let raw_name = String::from_utf8_lossy(&b[name_start..name_start + name_len]).to_string();

        if normalize_archive_path(&raw_name).is_none() {
            return Err(validation(format!("Archive contains unsafe path: {}", raw_name)));
        }
        if flags & 0x1 != 0 {
            return Err(validation("Encrypted zip entries are not supported"));
        }
        let file_type = (external_attrs >> 16) & 0o170000;
        if file_type != 0 && file_type != 0o100000 && file_type != 0o040000 {
            return Err(validation("Archive links are not supported"));
        }
        let is_dir = raw_name.replace('\\', "/").ends_with('/') || file_type == 0o040000;
        offset += 46 + name_len + extra_len + comment_len;

        extracted = extracted.saturating_add(uncompressed_size);
        if extracted > limits.max_extracted_bytes {
            return Err(validation(format!(
                "Archive extracts to more than {} bytes.",
                limits.max_extracted_bytes
            )));
        }
        if is_dir {
            continue;
        }

        // local file header
        if o32(b, local_offset) != LFH_SIG {
            return Err(validation("Invalid zip local file header"));
        }
        let l_name_len = u16(b, local_offset + 26) as usize;
        let l_extra_len = u16(b, local_offset + 28) as usize;
        let data_offset = local_offset + 30 + l_name_len + l_extra_len;
        if data_offset + compressed_size > b.len() {
            return Err(validation("Invalid zip archive: file data out of bounds"));
        }
        let compressed = &b[data_offset..data_offset + compressed_size];
        let contents: Vec<u8> = match method {
            0 => compressed.to_vec(),
            8 => {
                let mut out = Vec::with_capacity(uncompressed_size);
                let mut decoder = flate2::read::DeflateDecoder::new(compressed);
                decoder
                    .read_to_end(&mut out)
                    .map_err(|e| validation(format!("Invalid zip: deflate error {}", e)))?;
                out
            }
            m => {
                return Err(validation(format!("Unsupported zip compression method: {}", m)));
            }
        };
        if contents.len() != uncompressed_size {
            return Err(validation("Zip entry size mismatch"));
        }
        if crc32(&contents) != crc_expected {
            return Err(validation("Zip entry checksum mismatch"));
        }
        files.insert(normalize_archive_path(&raw_name).unwrap(), contents);
    }
    Ok(files)
}

fn o32(b: &[u8], o: usize) -> u32 {
    if o + 4 <= b.len() {
        u32(b, o)
    } else {
        0
    }
}

// ─── tar（含 gzip 外壳）───────────────────────────────────────────────

pub fn read_tar_archive(bytes: &[u8], limits: &Limits) -> Res<BTreeMap<String, Vec<u8>>> {
    let buffer: Vec<u8>;
    if bytes.len() >= 2 && bytes[0] == 0x1f && bytes[1] == 0x8b {
        let mut out = Vec::new();
        MultiGzDecoder::new(bytes)
            .read_to_end(&mut out)
            .map_err(|e| validation(format!("Invalid gzip: {}", e)))?;
        if out.len() > limits.max_extracted_bytes {
            return Err(validation(format!(
                "Archive extracts to more than {} bytes.",
                limits.max_extracted_bytes
            )));
        }
        buffer = out;
    } else {
        buffer = bytes.to_vec();
    }
    if buffer.len() % 512 != 0 {
        return Err(validation("Invalid tar archive: size not a multiple of 512"));
    }

    let mut files = BTreeMap::new();
    let mut extracted: usize = 0;
    let mut entries = 0usize;
    let mut offset = 0usize;
    let mut pending_long_name = String::new();

    while offset + 512 <= buffer.len() {
        let header = &buffer[offset..offset + 512];
        if header.iter().all(|b| *b == 0) {
            break;
        }
        let magic = String::from_utf8_lossy(&header[257..263]).to_string();
        if magic != "ustar\0" && magic != "ustar " {
            return Err(validation(format!("Invalid tar archive: bad magic at block {}", offset / 512)));
        }
        let size = octal_field(&header[124..136])?;
        let typeflag = header[156] as char;
        let prefix = cstr(&header[345..500]);
        let mut name = cstr(&header[0..100]);
        if !prefix.is_empty() {
            name = format!("{}/{}", prefix, name);
        }

        let data_start = offset + 512;
        let data_len = size.div_ceil(512) * 512;
        if data_start + data_len > buffer.len() {
            return Err(validation("Invalid tar archive: entry data out of bounds"));
        }
        let data = &buffer[data_start..(data_start + size).min(buffer.len())];

        if typeflag == 'L' {
            pending_long_name = cstr(data);
            offset = data_start + data_len;
            continue;
        }
        if typeflag == 'K' {
            offset = data_start + data_len;
            continue;
        }
        if !pending_long_name.is_empty() {
            name = pending_long_name.clone();
            pending_long_name.clear();
        }

        entries += 1;
        if entries > limits.max_entries {
            return Err(validation(format!(
                "Archive contains too many files ({}). Maximum is {}.",
                entries, limits.max_entries
            )));
        }
        let Some(file_name) = normalize_archive_path(&name) else {
            return Err(validation(format!("Archive contains unsafe path: {}", name)));
        };
        if typeflag == '1' || typeflag == '2' {
            return Err(validation("Archive links are not supported"));
        }
        if typeflag != '0' && typeflag != '\0' && typeflag != '5' {
            return Err(validation(format!("Unsupported tar entry type: {:?}", typeflag)));
        }
        extracted += size;
        if extracted > limits.max_extracted_bytes {
            return Err(validation(format!(
                "Archive extracts to more than {} bytes.",
                limits.max_extracted_bytes
            )));
        }
        if typeflag != '5' && !file_name.ends_with('/') {
            files.insert(file_name, data.to_vec());
        }
        offset = data_start + data_len;
    }
    Ok(files)
}

fn octal_field(field: &[u8]) -> Res<usize> {
    let raw: String = field
        .iter()
        .filter(|b| **b != 0 && **b != b' ')
        .map(|b| *b as char)
        .collect();
    if raw.is_empty() {
        return Ok(0);
    }
    if !raw.chars().all(|c| c.is_digit(8)) {
        return Err(validation("Invalid tar archive: non-octal size field"));
    }
    usize::from_str_radix(&raw, 8).map_err(|_| validation("Invalid tar archive: bad octal"))
}

fn cstr(bytes: &[u8]) -> String {
    let end = bytes.iter().position(|b| *b == 0).unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).to_string()
}

// ─── 统一入口 ─────────────────────────────────────────────────────────

pub fn read_archive(bytes: &[u8], limits: &Limits) -> Res<BTreeMap<String, Vec<u8>>> {
    if bytes.len() >= 2 && bytes[0] == 0x1f && bytes[1] == 0x8b {
        return read_tar_archive(bytes, limits);
    }
    if bytes.len() >= 4 && u32(bytes, 0) == 0x504b0304 {
        return read_zip_archive(bytes, limits);
    }
    Err(bad_input("Unsupported archive format (expected zip or tar.gz)"))
}

// ─── CRC32（zip 校验用）──────────────────────────────────────────────

fn crc_table() -> &'static [u32; 256] {
    use once_cell::sync::Lazy;
    static TABLE: Lazy<[u32; 256]> = Lazy::new(|| {
        let mut table = [0u32; 256];
        for (i, item) in table.iter_mut().enumerate() {
            let mut c = i as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 { 0xedb88320 ^ (c >> 1) } else { c >> 1 };
            }
            *item = c;
        }
        table
    });
    &TABLE
}

pub fn crc32(data: &[u8]) -> u32 {
    let table = crc_table();
    let mut crc = 0xffffffffu32;
    for b in data {
        crc = table[((crc ^ *b as u32) & 0xff) as usize] ^ (crc >> 8);
    }
    crc ^ 0xffffffff
}
