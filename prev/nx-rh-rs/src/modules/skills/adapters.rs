// 平台适配器表：各 AI 编码工具读取 skill 的目录约定 —— 与 skills/adapters.js 对齐。
// 这张表是唯一真相源。

use crate::core::paths::CowStrExt;
use std::path::PathBuf;


use crate::core::paths::home_dir;

pub struct Adapter {
    pub id: &'static str,
    pub name: &'static str,
    pub dir: &'static str,
    pub global_dir: &'static str,
    pub universal: bool,
}

pub const ADAPTERS: &[Adapter] = &[
    Adapter { id: "claude-code", name: "Claude Code", dir: ".claude/skills", global_dir: ".claude/skills", universal: false },
    Adapter { id: "workbuddy", name: "WorkBuddy", dir: ".workbuddy/skills", global_dir: ".workbuddy/skills", universal: false },
    Adapter { id: "workbuddy-ai", name: "WorkBuddyAI（国际版）", dir: ".workbuddy-ai/skills", global_dir: ".workbuddy-ai/skills", universal: false },
    Adapter { id: "doubao", name: "Doubao（豆包）", dir: ".doubao/skills", global_dir: "Doubao/skills", universal: false },
    Adapter { id: "doubao-work", name: "DoubaoWork（豆包办公）", dir: ".doubaowork/skills", global_dir: "DoubaoWork/skills", universal: false },
    Adapter { id: "qianwen", name: "Qianwen（千问办公）", dir: ".qwenworkcn/skills", global_dir: ".qwenworkcn/skills", universal: false },
    Adapter { id: "trae-cn", name: "Trae CN（国内版）", dir: ".trae/skills", global_dir: ".trae-cn/skills", universal: false },
    Adapter { id: "qoder", name: "Qoder", dir: ".qoder/skills", global_dir: ".qoder/skills", universal: false },
    Adapter { id: "qoder-cn", name: "QoderCN（中国版）", dir: ".qoder-cn/skills", global_dir: ".qoder-cn/skills", universal: false },
    Adapter { id: "agents", name: "Universal (.agents)", dir: ".agents/skills", global_dir: ".agents/skills", universal: true },
    Adapter { id: "codebuddy", name: "CodeBuddy", dir: ".codebuddy/skills", global_dir: ".codebuddy/skills", universal: false },
    Adapter { id: "cursor", name: "Cursor", dir: ".cursor/skills", global_dir: ".cursor/skills", universal: false },
    Adapter { id: "codex", name: "Codex", dir: ".codex/skills", global_dir: ".codex/skills", universal: false },
    Adapter { id: "gemini-cli", name: "Gemini CLI", dir: ".gemini/skills", global_dir: ".gemini/skills", universal: false },
    Adapter { id: "copilot", name: "GitHub Copilot", dir: ".copilot/skills", global_dir: ".copilot/skills", universal: false },
    Adapter { id: "windsurf", name: "Windsurf", dir: ".windsurf/skills", global_dir: ".codeium/windsurf/skills", universal: false },
    Adapter { id: "iflow-cli", name: "iFlow CLI", dir: ".iflow/skills", global_dir: ".iflow/skills", universal: false },
];

pub const SCOPES: [&str; 2] = ["user", "project"];

/// 平台别名 → 归一 id。认不出返回 ''。
pub fn normalize_platform_id(input: &str) -> String {
    if input.is_empty() {
        return String::new();
    }
    let k = input.trim().to_lowercase();
    if k == "all" {
        return "all".into();
    }
    let alias = match k.as_str() {
        "claude" | "claude-code" | "cc" => "claude-code",
        "workbuddy" | "wb" => "workbuddy",
        "workbuddy-ai" | "workbuddyai" | "wbai" | "wb-ai" => "workbuddy-ai",
        "doubao" => "doubao",
        "doubao-work" | "doubaowork" | "dbw" => "doubao-work",
        "qianwen" | "qwenwork" | "qwen" | "qw" => "qianwen",
        "trae-cn" | "trae" => "trae-cn",
        "qoder" => "qoder",
        "qoder-cn" | "qodercn" => "qoder-cn",
        "codebuddy" | "cb" => "codebuddy",
        "cursor" => "cursor",
        "codex" => "codex",
        "gemini" | "gemini-cli" => "gemini-cli",
        "copilot" => "copilot",
        "windsurf" => "windsurf",
        "iflow" | "iflow-cli" => "iflow-cli",
        "agents" | "universal" => "agents",
        _ => "",
    };
    if !alias.is_empty() {
        return alias.into();
    }
    if ADAPTERS.iter().any(|a| a.id == k) {
        return k;
    }
    String::new()
}

pub fn adapter_by_id(input: &str) -> Option<&'static Adapter> {
    let id = normalize_platform_id(input);
    if id.is_empty() || id == "all" {
        return None;
    }
    ADAPTERS.iter().find(|a| a.id == id)
}

pub fn platform_names() -> Vec<&'static str> {
    ADAPTERS.iter().map(|a| a.id).collect()
}

/// 解析一次迁移的落点目录（绝对路径字符串）。
pub fn target_dir_for(adapter_id: &str, scope: &str, project_root: &str) -> Option<String> {
    let a = adapter_by_id(adapter_id)?;
    Some(if scope == "user" {
        home_dir().join(a.global_dir).to_string_lossy().native()
    } else {
        PathBuf::from(project_root).join(a.dir).to_string_lossy().native()
    })
}
