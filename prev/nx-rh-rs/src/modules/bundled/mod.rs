// 内置 skill 包模块 —— 与 modules/bundled/index.js 对齐。

pub mod service;

use serde_json::{json, Value};

use crate::core::errors::{bad_input, Res};
use crate::runtime::spec::{Action, ArgSpec, FlagSpec};

#[allow(dead_code)]
fn aarg(name: &'static str) -> ArgSpec {
    ArgSpec { name, required: true, rest: false }
}
fn oarg(name: &'static str) -> ArgSpec {
    ArgSpec { name, required: false, rest: false }
}

fn group_flag() -> FlagSpec {
    FlagSpec { name: "group", kind: "string", required: false, default: None, enum_values: None, hint: "groups.json 里的组名（与 <name> 互斥）" }
}

/// <name> 与 --group 互斥。
fn exclusive(ctx: &Value, cmd: &str) -> Res<()> {
    let group = ctx["group"].as_str().unwrap_or("");
    let name = ctx["name"].as_str().unwrap_or("");
    if !group.is_empty() && !name.is_empty() {
        return Err(bad_input(format!("{} 的 <name> 与 --group 只能给一个", cmd)));
    }
    Ok(())
}

/// get 的三段拼接（顺序固定）。
fn render_content(d: &Value) -> String {
    let i = &d["install"];
    let inst = if i["status"].as_str() == Some("conflict") {
        format!(
            "冲突: {}（{} 个文件不同）—— 需要覆盖时用 nx-rh-rs skill install --force",
            i["path"].as_str().unwrap_or(""),
            i["count"]
        )
    } else if i["skipped"].as_bool().unwrap_or(false) {
        format!("已是最新: {}（无差异）", i["path"].as_str().unwrap_or(""))
    } else if i["replaced"].as_bool().unwrap_or(false) {
        format!("已替换: {}", i["path"].as_str().unwrap_or(""))
    } else {
        format!("已安装: {}", i["path"].as_str().unwrap_or(""))
    };
    [
        format!("# === {} skill context ===", d["skillName"].as_str().unwrap_or("")),
        format!("# 以下内容来自 nx-rh-rs skill `{}` 的 {}。", d["skillName"].as_str().unwrap_or(""), d["ref"].as_str().unwrap_or("")),
        "# 建议：把 sentinel 之后的正文完整复制到你自己可访问的路径，再按其内容操作。".to_string(),
        "# --- begin skill content (do not modify this line) ---".to_string(),
        String::new(),
        d["content"].as_str().unwrap_or("").trim_end().to_string(),
        String::new(),
        "-- install 状态 --".to_string(),
        inst,
    ]
    .join("\n")
}

use once_cell::sync::Lazy;

/// action 表（Lazy：Action 里含 Vec 字段，放不进 static 数组）。
pub fn actions() -> &'static Vec<Action> {
    static ACTIONS: Lazy<Vec<Action>> = Lazy::new(|| vec![
    Action {
        id: "bundled.list",
        cli: vec![vec!["skill", "list"], vec!["skill", "install", "--list"], vec!["bundled", "list"]],
        http: Some(("GET", "/api/bundled")),
        summary: "列出包内自带 skill（含文件数与描述）+ 默认装哪个 + 有哪些 group",
        args: vec![],
        flags: vec![],
        module: "bundled",
        run: |ctx, transport| {
            let info = service::groups_info()?;
            if transport != "http" {
                return Ok(info);
            }
            let details = service::list_bundled_skills()?;
            let mut out = info.clone();
            out["defaultDir"] = json!(service::default_skills_dir().to_string_lossy());
            out["skills"] = json!(details);
            out["details"] = json!(details);
            let _ = ctx;
            Ok(out)
        },
        render: Some(|d, _ctx| {
            let skills: Vec<String> = d["skills"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect();
            let default_group = d["defaultGroup"].as_str().unwrap_or("");
            // 默认组装哪些 skill：取 groupSkills[defaultGroup]（JS 用 def.includes(s) 判定），
            // 不是「名字等于组名」——组名可以包含多个 skill。
            let default_skills: Vec<String> = d
                .pointer(&format!("/groupSkills/{}", default_group))
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
                .unwrap_or_default();
            let w = skills.iter().map(|s| s.len()).max().unwrap_or(0);
            let mut lines: Vec<String> = vec!["可装的 skill:".into()];
            for s in &skills {
                // padEnd(w) 后再补两个空格 —— w 不能加，加了列宽就多两格（与 JS 对不上）。
                if default_skills.contains(s) {
                    lines.push(format!("  * {:<w$}  （默认 install）", s));
                } else {
                    lines.push(format!("  * {}", s));
                }
            }
            lines.push("可装的 group:".into());
            let groups: Vec<String> = d["groups"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect();
            for g in &groups {
                let summary = d
                    .pointer(&format!("/summaries/{}", g))
                    .and_then(|s| s.as_str())
                    .unwrap_or("");
                if !summary.is_empty() {
                    lines.push(format!("  * {:<w$}  {}", g, summary));
                } else {
                    lines.push(format!("  * {}", g));
                }
            }
            if d["source"].as_str() == Some("assets-dirs") {
                lines.push(String::new());
                lines.push("（assets/groups.json 缺失或损坏，已降级为目录扫描：每个内置 skill 各成一组）".into());
            }
            lines.join("\n")
        }),
    },
    Action {
        id: "bundled.groups",
        cli: vec![vec!["skill", "groups"], vec!["bundled", "groups"]],
        http: Some(("GET", "/api/bundled/groups")),
        summary: "列出可装的 group（groups.json 的组名 → 它包含哪些 skill）",
        args: vec![],
        flags: vec![],
        module: "bundled",
        run: |_, _| service::groups_info(),
        render: Some(|d, _ctx| {
            let default_group = d["defaultGroup"].as_str().unwrap_or("");
            let mut lines: Vec<String> = Vec::new();
            lines.push(format!(
                "可装的 group（来源: {}{}）:",
                d["source"].as_str().unwrap_or(""),
                if default_group.is_empty() { String::new() } else { format!(" · 默认组: {}", default_group) }
            ));
            let groups: Vec<String> = d["groups"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect();
            for g in &groups {
                let summary = d
                    .pointer(&format!("/summaries/{}", g))
                    .and_then(|s| s.as_str())
                    .unwrap_or("");
                if !summary.is_empty() {
                    lines.push(format!("  {}  —— {}", g, summary));
                } else {
                    lines.push(format!("  {}", g));
                }
                let skills = d
                    .pointer(&format!("/groupSkills/{}", g))
                    .cloned()
                    .unwrap_or(json!([]));
                lines.push(format!(
                    "      skills: {}",
                    skills
                        .as_array()
                        .map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(", "))
                        .unwrap_or_default()
                ));
            }
            if groups.is_empty() {
                lines.push("  （无）".into());
            }
            lines.join("\n")
        }),
    },
    Action {
        id: "bundled.install",
        cli: vec![vec!["skill", "install"]],
        http: Some(("POST", "/api/bundled/install")),
        summary: "安装内置 skill 到 skills 目录（默认 nx-rh → ~/.claude/skills；--group <key> 一键装一组）",
        args: vec![oarg("name")],
        flags: vec![
            group_flag(),
            FlagSpec { name: "to", kind: "string", required: false, default: None, enum_values: None, hint: "" },
            FlagSpec { name: "force", kind: "boolean", required: false, default: None, enum_values: None, hint: "" },
        ],
        module: "bundled",
        run: |ctx, _| {
            exclusive(ctx, "skill install")?;
            service::install_bundled_skill(
                ctx["name"].as_str().unwrap_or(""),
                ctx["group"].as_str().unwrap_or(""),
                ctx["to"].as_str().unwrap_or(""),
                ctx["force"].as_bool().unwrap_or(false),
            )
        },
        render: Some(|d, _ctx| {
            if let Some(group) = d["group"].as_str().filter(|g| !g.is_empty()) {
                let _ = group;
                let skills = d["skills"].as_array().cloned().unwrap_or_default();
                let done = skills.iter().filter(|r| r["status"].as_str() == Some("ok")).count();
                let mut lines: Vec<String> = Vec::new();
                lines.push(format!("group {}: {}/{} 已就绪", d["group"].as_str().unwrap_or(""), done, skills.len()));
                for r in &skills {
                    let what = if r["status"].as_str() == Some("conflict") {
                        format!("冲突（{} 个文件不同）→ 用 --force 覆盖", r["count"])
                    } else if r["skipped"].as_bool().unwrap_or(false) {
                        "已是最新".to_string()
                    } else {
                        format!(
                            "{}（{} 个文件）-> {}",
                            if r["replaced"].as_bool().unwrap_or(false) { "已更新" } else { "已安装" },
                            r["files"],
                            r["path"].as_str().unwrap_or("")
                        )
                    };
                    lines.push(format!("  {:<16} {}", r["name"].as_str().unwrap_or(""), what));
                }
                return lines.join("\n");
            }
            if d["status"].as_str() == Some("conflict") {
                let files: Vec<String> = d["files"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .iter()
                    .map(|f| format!("  {}  {}", f["file"].as_str().unwrap_or(""), f["side"].as_str().unwrap_or("")))
                    .collect();
                return format!(
                    "目标已存在且内容不同（{} 个文件）: {}\n{}\n用 --force 覆盖，或先删除目标目录",
                    d["count"],
                    d["path"].as_str().unwrap_or(""),
                    files.join("\n")
                );
            }
            if d["skipped"].as_bool().unwrap_or(false) {
                return format!("已是最新，无需安装: {}", d["path"].as_str().unwrap_or(""));
            }
            format!(
                "{} {}（{} 个文件）-> {}",
                if d["replaced"].as_bool().unwrap_or(false) { "已更新" } else { "已安装" },
                d["name"].as_str().unwrap_or(""),
                d["files"],
                d["path"].as_str().unwrap_or("")
            )
        }),
    },
    Action {
        id: "bundled.get",
        cli: vec![vec!["skill", "get"]],
        http: Some(("GET", "/api/bundled/content")),
        summary: "输出内置 skill 全文（prefix + sentinel + 正文 + install 状态），并顺手装到本机",
        args: vec![oarg("name"), oarg("ref")],
        flags: vec![
            group_flag(),
            FlagSpec { name: "to", kind: "string", required: false, default: None, enum_values: None, hint: "" },
        ],
        module: "bundled",
        run: |ctx, _| {
            exclusive(ctx, "skill get")?;
            service::bundled_skill_content(
                ctx["name"].as_str().unwrap_or(""),
                ctx["group"].as_str().unwrap_or(""),
                ctx["ref"].as_str().unwrap_or(""),
                ctx["to"].as_str().unwrap_or(""),
            )
        },
        render: Some(|d, _ctx| {
            if let Some(group) = d["group"].as_str().filter(|g| !g.is_empty()) {
                let _ = group;
                let parts: Vec<String> = d["skills"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .iter()
                    .map(render_content)
                    .collect();
                return parts.join(&format!("\n\n{}\n\n", "─".repeat(60)));
            }
            render_content(d)
        }),
    },
    ]);
    &ACTIONS
}
