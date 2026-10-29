// Markdown 结构抽取：前 N 级标题 + 规模统计 —— 与 core/mdoutline.js 对齐。

#[derive(Debug, Clone, serde::Serialize)]
pub struct OutlineItem {
    pub level: usize,
    pub text: String,
    pub line: usize,
}

/// 抽取 1..=maxLevel 级 ATX 标题。代码围栏里的 # 不是标题。
pub fn md_outline(text: &str, max_level: usize) -> Vec<OutlineItem> {
    let mut out = Vec::new();
    let mut fence = '\0';
    for (i, line) in text.lines().enumerate() {
        let t = line.trim_start();
        if let Some(rest) = t.strip_prefix("```").or_else(|| t.strip_prefix("~~~")) {
            let _ = rest;
            let ch = t.chars().next().unwrap_or('\0');
            if fence == '\0' {
                fence = ch;
            } else if ch == fence {
                fence = '\0';
            }
            continue;
        }
        if fence != '\0' {
            continue;
        }
        let hashes = line.chars().take_while(|c| *c == '#').count();
        if hashes >= 1 && hashes <= 6 && hashes <= max_level {
            let rest = &line[hashes..];
            if let Some(stripped) = rest.strip_prefix(' ') {
                let mut text = stripped.trim();
                // 去掉行尾 #* 装饰
                while text.ends_with('#') {
                    text = text[..text.len() - 1].trim_end();
                }
                if !text.is_empty() {
                    out.push(OutlineItem { level: hashes, text: text.to_string(), line: i + 1 });
                }
            }
        }
    }
    out
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct MdStats {
    pub lines: usize,
    pub bytes: usize,
    pub sections: usize,
}

pub fn md_stats(text: &str, outline: &[OutlineItem]) -> MdStats {
    MdStats {
        lines: if text.is_empty() { 0 } else { text.lines().count() },
        bytes: text.len(),
        sections: outline.len(),
    }
}
