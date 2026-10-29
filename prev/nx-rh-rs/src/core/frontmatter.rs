// SKILL.md frontmatter 解析 —— 与 core/frontmatter.js 同语义。
// CRLF 归一化后逐行解析；只解析 name / description 两个字段。
// 支持单行值、成对引号值、| / > 块标量、缩进续行。

pub struct Frontmatter {
    pub name: String,
    pub description: String,
}

/// 返回 { name, description }；无 frontmatter 或字段缺失时为空串。
pub fn parse_frontmatter(raw: &str) -> Frontmatter {
    let mut content = raw.strip_prefix('\u{feff}').unwrap_or(raw).to_string();
    content = content.replace("\r\n", "\n").replace('\r', "\n");

    let lines: Vec<&str> = content.split('\n').collect();
    if lines.first().map(|l| l.trim_end()).unwrap_or("") != "---" {
        return Frontmatter { name: String::new(), description: String::new() };
    }
    // 找结束的 ---
    let end = lines
        .iter()
        .enumerate()
        .skip(1)
        .find(|(_, l)| l.trim_end() == "---")
        .map(|(i, _)| i);
    let Some(end) = end else {
        return Frontmatter { name: String::new(), description: String::new() };
    };
    let fm_lines = &lines[1..end];
    Frontmatter {
        name: read_field(fm_lines, "name").trim().to_string(),
        description: read_field(fm_lines, "description").trim().to_string(),
    }
}

fn unquote(v: &str) -> String {
    let s = v.trim();
    if s.len() >= 2
        && ((s.starts_with('"') && s.ends_with('"')) || (s.starts_with('\'') && s.ends_with('\'')))
    {
        return s[1..s.len() - 1].trim().to_string();
    }
    s.to_string()
}

fn strip_indent(l: &str) -> String {
    if let Some(r) = l.strip_prefix("  ") {
        return r.to_string();
    }
    if let Some(r) = l.strip_prefix('\t') {
        return r.to_string();
    }
    l.trim_start_matches([' ', '\t']).to_string()
}

fn read_field(lines: &[&str], key: &str) -> String {
    let prefix = format!("{}:", key);
    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim_start();
        if !trimmed.starts_with(&prefix) {
            continue;
        }
        // 键后必须是空白或行尾（name: 与 name:xx 区分）
        let rest = &trimmed[prefix.len()..];
        if !rest.is_empty() && !rest.starts_with(' ') && !rest.starts_with('\t') {
            continue;
        }
        let raw_val = rest.trim().to_string();
        let is_block = matches!(raw_val.as_str(), "|" | ">" | "|-" | ">-" | "|+" | ">+");
        if !is_block && !raw_val.is_empty() {
            return unquote(&raw_val);
        }

        // 块标量或空值：收集后续缩进行
        let mut block: Vec<String> = Vec::new();
        for l in lines.iter().skip(i + 1) {
            if l.trim().is_empty() {
                block.push(String::new());
                continue;
            }
            if !l.starts_with(' ') && !l.starts_with('\t') {
                break;
            }
            block.push(strip_indent(l));
        }
        let text = block.join("\n").trim().to_string();
        if !text.is_empty() {
            if raw_val.starts_with('>') {
                // 折叠标量：换行折叠成空格
                let re = text
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ");
                return re;
            }
            return text;
        }
        return unquote(&raw_val);
    }
    String::new()
}
