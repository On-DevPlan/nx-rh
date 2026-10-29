// Skill 模块的 CLI 人读渲染 —— 与 skills/renders.js 对齐。

use serde_json::Value;

use super::shared::{scope_mark, source_label, source_labels};

pub fn cell_text(cells: &Value) -> String {
    let arr = cells.as_array().cloned().unwrap_or_default();
    if arr.is_empty() {
        return String::new();
    }
    let on: Vec<&Value> = arr.iter().filter(|c| c["on"].as_bool().unwrap_or(false)).collect();
    if on.is_empty() {
        return "未安装".into();
    }
    on.iter()
        .map(|c| {
            let scope = c["scope"].as_str().unwrap_or("");
            let platform = c["platform"].as_str().unwrap_or("");
            let link = c["linkType"].as_str().unwrap_or("");
            let form = if link.is_empty() { "(副本)" } else { "(链接)" };
            format!("{}·{}{}", scope_mark(scope), platform, form)
        })
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn render_skill_list(d: &Value, ctx: &Value) -> String {
    let mut lines: Vec<String> = Vec::new();
    lines.push(format!(
        "订阅源: {}",
        d.pointer("/hub/path").and_then(|p| p.as_str()).filter(|s| !s.is_empty()).unwrap_or("（未订阅）")
    ));
    for s in d["sources"].as_array().cloned().unwrap_or_default() {
        lines.push(format!(
            "  {} {}  ({} 个)",
            if s["current"].as_bool().unwrap_or(false) { "*" } else { " " },
            s["path"].as_str().unwrap_or(""),
            s["count"]
        ));
    }
    lines.push(String::new());
    for p in d["hubProblems"].as_array().cloned().unwrap_or_default() {
        lines.push(format!(
            "! {}  —— {}",
            p["reason"].as_str().unwrap_or(""),
            p["path"].as_str().unwrap_or("")
        ));
    }
    let conflicts = d["conflicts"].as_array().cloned().unwrap_or_default();
    for c in conflicts.iter().filter(|c| !c["same"].as_bool().unwrap_or(false)) {
        lines.push(format!(
            "! 同名 skill 在多个订阅源且内容不同: {}  —— {}",
            c["name"].as_str().unwrap_or(""),
            source_labels(&c["sources"])
        ));
    }
    for c in conflicts.iter().filter(|c| c["same"].as_bool().unwrap_or(false)) {
        lines.push(format!(
            "· 重复订阅（内容一致）: {}  —— {}",
            c["name"].as_str().unwrap_or(""),
            source_labels(&c["sources"])
        ));
    }
    let has_problems = !d["hubProblems"].as_array().map(|a| a.is_empty()).unwrap_or(true)
        || !conflicts.is_empty();
    if has_problems {
        lines.push(String::new());
    }

    let skills = d["skills"].as_array().cloned().unwrap_or_default();
    let src_all: Vec<String> = {
        let mut v: Vec<String> = skills
            .iter()
            .filter_map(|s| s["source"].as_str().map(|x| x.to_string()))
            .collect();
        v.dedup();
        v
    };
    let multi = src_all.len() > 1;
    if skills.is_empty() {
        lines.push("（订阅源里暂无 skill）".into());
    }
    let long = ctx.get("long").and_then(|l| l.as_bool()).unwrap_or(false);
    for s in &skills {
        if long {
            lines.push(s["name"].as_str().unwrap_or("").to_string());
            lines.push(format!("  目录: {}", s["dir"].as_str().unwrap_or("")));
            lines.push(format!("  来源: {}", s["source"].as_str().unwrap_or("")));
            if let Some(spec) = s.pointer("/upstream/spec").and_then(|x| x.as_str()).filter(|x| !x.is_empty()) {
                let r = s.pointer("/upstream/ref").and_then(|x| x.as_str()).unwrap_or("");
                let hash: String = s
                    .pointer("/upstream/hash")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .chars()
                    .take(8)
                    .collect();
                lines.push(format!(
                    "  上游: {}{}  ·  版本 {}",
                    spec,
                    if r.is_empty() { String::new() } else { format!("@{}", r) },
                    hash
                ));
            }
            let also_in: Vec<String> = s["alsoIn"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .filter_map(|x| x.as_str().map(|y| y.to_string()))
                .collect();
            if !also_in.is_empty() {
                lines.push(format!("  同时存在于: {}", also_in.join(", ")));
            }
            lines.push(format!("  描述: {}", s["description"].as_str().unwrap_or("")));
            let cells = cell_text(&s["cells"]);
            lines.push(format!("  安装: {}", if cells.is_empty() { "未安装" } else { &cells }));
            lines.push(String::new());
            continue;
        }
        let tag = if multi {
            format!("  [{}]", source_label(s["source"].as_str().unwrap_or(""), &src_all))
        } else {
            String::new()
        };
        let up = if s.pointer("/upstream/spec").and_then(|x| x.as_str()).map(|x| !x.is_empty()).unwrap_or(false) {
            format!("  ↑{}", s.pointer("/upstream/spec").and_then(|x| x.as_str()).unwrap_or(""))
        } else {
            String::new()
        };
        let name = s["name"].as_str().unwrap_or("");
        lines.push(format!(
            "{:<28} {}{}{}",
            name,
            s["description"].as_str().unwrap_or("").chars().take(48).collect::<String>(),
            tag,
            up
        ).trim_end().to_string());
    }
    let orphans = d["orphans"].as_array().cloned().unwrap_or_default();
    if !orphans.is_empty() {
        lines.push(String::new());
        lines.push(format!(
            "不在订阅源（{} 个，可 skill submit 收进）:",
            orphans.len()
        ));
        for o in &orphans {
            let name = o["name"].as_str().unwrap_or("");
            lines.push(format!(
                "  {:<26} {}",
                name,
                cell_text(&o["cells"])
            ));
        }
    }
    if !long {
        lines.push(String::new());
        lines.push("（--long 看完整描述与目录；skill hub show <name> 看各平台安装状态）".to_string());
    }
    lines.join("\n")
}

pub fn render_sources(d: &Value, _ctx: &Value) -> String {
    let sources = d["sources"].as_array().cloned().unwrap_or_default();
    if sources.is_empty() {
        return "（暂无订阅源，用 nx-rh-rs skill hub subscribe <path> 添加；外部 skill 走 skill hub remote import）".into();
    }
    sources
        .iter()
        .map(|s| {
            let remote = if s.get("remote").map(|r| !r.is_null()).unwrap_or(false) {
                "  ← 远程订阅"
            } else {
                ""
            };
            format!(
                "  {} {}  ({} 个){}{}",
                if s["current"].as_bool().unwrap_or(false) { "*" } else { " " },
                s["path"].as_str().unwrap_or(""),
                s["count"],
                if s["exists"].as_bool().unwrap_or(false) { "" } else { "  [目录不存在]" },
                remote
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn render_project_list(d: &Value, _ctx: &Value) -> String {
    let mut lines: Vec<String> = Vec::new();
    lines.push(format!(
        "项目目录: {}",
        d["projectRoot"].as_str().unwrap_or("")
    ));
    for dir in d["dirs"].as_array().cloned().unwrap_or_default() {
        let enabled = dir["enabled"].as_bool().unwrap_or(false);
        lines.push(format!(
            "  {} {}  ({} 个{})",
            if enabled { "*" } else { " " },
            dir["dir"].as_str().unwrap_or(""),
            dir["skills"].as_array().map(|a| a.len()).unwrap_or(0),
            if enabled { String::new() } else { "，平台未启用".into() }
        ));
    }
    let skills = d["skills"].as_array().cloned().unwrap_or_default();
    if skills.is_empty() {
        lines.push(String::new());
        lines.push("（项目目录里没有 skill）".into());
    }
    for s in &skills {
        let in_hub = s["inHub"].as_bool().unwrap_or(false);
        lines.push(format!(
            "{}{:<28} {}",
            if in_hub { "  " } else { "· " },
            s["name"].as_str().unwrap_or(""),
            s["description"].as_str().unwrap_or("").chars().take(48).collect::<String>()
        ).trim_end().to_string());
        let platforms: Vec<String> = s["cells"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|c| {
                c["platformName"]
                    .as_str()
                    .or_else(|| c["platform"].as_str())
                    .unwrap_or("")
                    .to_string()
            })
            .collect();
        lines.push(format!("    安装于: {}", platforms.join(" / ")));
    }
    if skills.iter().any(|s| !s["inHub"].as_bool().unwrap_or(false)) {
        lines.push(String::new());
        lines.push("（· 开头 = 不在订阅源，可用 nx-rh-rs skill submit <name> 收进）".into());
    }
    lines.join("\n")
}

pub fn render_migrate(d: &Value, _ctx: &Value) -> String {
    let dry_run = d["dryRun"].as_bool().unwrap_or(false);
    if !dry_run && d["status"].as_str() == Some("blocked") {
        let mut lines: Vec<String> = Vec::new();
        let blocked = d["blocked"].as_array().cloned().unwrap_or_default();
        lines.push(format!(
            "已阻止: {} 处无法迁移 —— 同名 skill 在多个订阅源且内容不同（来源冲突）",
            blocked.len()
        ));
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        for b in &blocked {
            let name = b["name"].as_str().unwrap_or("").to_string();
            if seen.contains(&name) {
                continue;
            }
            seen.insert(name);
            let sources = b["sources"].as_array().cloned().unwrap_or_default();
            let all: Vec<String> = sources
                .iter()
                .filter_map(|s| s["source"].as_str().map(|x| x.to_string()))
                .collect();
            let parts: Vec<String> = sources
                .iter()
                .map(|s| {
                    format!(
                        "{}({})",
                        source_label(s["source"].as_str().unwrap_or(""), &all),
                        s["md5"].as_str().unwrap_or("").chars().take(6).collect::<String>()
                    )
                })
                .collect();
            lines.push(format!("  {:<28} {}", b["name"].as_str().unwrap_or(""), parts.join("  ")));
        }
        lines.push("先解决订阅（删掉多余来源），或用 --source <路径> 指定用哪一份。".into());
        return lines.join("\n");
    }
    let mark = |r: &Value| -> String {
        let scope = r["scope"].as_str().unwrap_or("");
        let platform = r["platform"].as_str().unwrap_or("");
        let r#where = format!("{}·{}", scope_mark(scope), platform);
        if r["skipped"].as_bool().unwrap_or(false) {
            return format!("{} 已是最新", r#where);
        }
        if dry_run {
            return format!(
                "{} {}",
                r#where,
                if r["wouldCreate"].as_bool().unwrap_or(false) { "将创建" } else { "将覆盖" }
            );
        }
        let how = if r["mode"].as_str() == Some("symlink") {
            format!("软链接 {}", r["linkType"].as_str().unwrap_or("")).trim().to_string()
        } else {
            "复制".to_string()
        };
        format!(
            "{} {}{}",
            r#where,
            how,
            if r["degraded"].as_bool().unwrap_or(false) { "（链接失败已降级复制）" } else { "" }
        )
    };
    let selected = d["selected"].as_array().cloned().unwrap_or_default();
    let multi = selected.len() > 1;
    let head = if dry_run {
        format!(
            "预演（--dry-run，未改动磁盘）: 选中 {} 个 · 将变更 {} 处 · 已是最新 {} 处",
            selected.len(),
            d["wouldChange"].as_u64().unwrap_or(0),
            d["skipped"].as_u64().unwrap_or(0)
        )
    } else {
        format!(
            "已迁移 {} 处（跳过 {}）· 选中 {} 个",
            d["migrated"].as_u64().unwrap_or(0),
            d["skipped"].as_u64().unwrap_or(0),
            selected.len()
        )
    };
    let mut lines = vec![head];
    for r in d["results"].as_array().cloned().unwrap_or_default() {
        if multi {
            lines.push(format!("  {:<28} {}", r["name"].as_str().unwrap_or(""), mark(&r)));
        } else {
            lines.push(format!("  {}", mark(&r)));
        }
    }
    lines.join("\n")
}

pub fn render_unmigrate(d: &Value, _ctx: &Value) -> String {
    let dry_run = d["dryRun"].as_bool().unwrap_or(false);
    if dry_run {
        let mut lines: Vec<String> = Vec::new();
        let selected = d["selected"].as_array().cloned().unwrap_or_default();
        let plan = d["plan"].as_array().cloned().unwrap_or_default();
        lines.push(format!(
            "预演（--dry-run，未改动磁盘）: 选中 {} 个 · 将移除 {} 处",
            selected.len(),
            plan.len()
        ));
        for x in &plan {
            lines.push(format!(
                "  {:<28} {}·{} {}",
                x["name"].as_str().unwrap_or(""),
                scope_mark(x["scope"].as_str().unwrap_or("")),
                x["platform"].as_str().unwrap_or(""),
                if !x["linkType"].as_str().unwrap_or("").is_empty() { "链接" } else { "实体副本" }
            ));
        }
        if plan.is_empty() {
            lines.push("  （这些目标本就没有该 skill）".into());
        }
        return lines.join("\n");
    }
    if d["status"].as_str() == Some("blocked") {
        let list: Vec<String> = d["needForce"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|x| {
                format!(
                    "  {}·{} {}",
                    scope_mark(x["scope"].as_str().unwrap_or("")),
                    x["platform"].as_str().unwrap_or(""),
                    x["path"].as_str().unwrap_or("")
                )
            })
            .collect();
        return format!("已阻止: {}\n{}", d["reason"].as_str().unwrap_or(""), list.join("\n"));
    }
    let removed = d["removed"].as_array().cloned().unwrap_or_default();
    if removed.is_empty() {
        return "（这些目标本就没有该 skill）".into();
    }
    let selected = d["selected"].as_array().cloned().unwrap_or_default();
    let multi = selected.len() > 1;
    let rows: Vec<String> = removed
        .iter()
        .map(|x| {
            let scope = scope_mark(x["scope"].as_str().unwrap_or(""));
            let platform = x["platform"].as_str().unwrap_or("");
            let form = if !x["linkType"].as_str().unwrap_or("").is_empty() { "链接" } else { "副本" };
            if multi {
                format!("  {:<28} {}·{} {}", x["name"].as_str().unwrap_or(""), scope, platform, form)
            } else {
                format!("  {}·{} {}", scope, platform, form)
            }
        })
        .collect();
    format!("已撤销 {} 处（选中 {} 个）:\n{}", removed.len(), selected.len(), rows.join("\n"))
}

pub fn render_submit(d: &Value, _ctx: &Value) -> String {
    let dry_run = d["dryRun"].as_bool().unwrap_or(false);
    if !dry_run && d["status"].as_str() == Some("conflict") {
        let c = &d["conflicts"].as_array().cloned().unwrap_or_default()[0];
        return format!(
            "订阅源里已存在同名 skill 且内容不同（{} 个文件）: {}\n用 --force 覆盖",
            c["files"].as_array().map(|a| a.len()).unwrap_or(0),
            c["path"].as_str().unwrap_or("")
        );
    }
    if let Some(count) = d["count"].as_u64() {
        let _ = count;
        if dry_run {
            let mut lines: Vec<String> = Vec::new();
            let selected = d["selected"].as_array().cloned().unwrap_or_default();
            lines.push(format!(
                "预演（--dry-run，未改动磁盘）: 选中 {} 个 · 将提交 {} 个",
                selected.len(),
                d["wouldSubmit"].as_u64().unwrap_or(0)
            ));
            for r in d["results"].as_array().cloned().unwrap_or_default() {
                let what = if r["status"].as_str() == Some("ok") {
                    "将收进订阅源并改回链接".to_string()
                } else {
                    r["reason"].as_str().unwrap_or(r["status"].as_str().unwrap_or("")).to_string()
                };
                lines.push(format!("  {:<28} {}", r["name"].as_str().unwrap_or(""), what));
            }
            return lines.join("\n");
        }
        let mut lines: Vec<String> = Vec::new();
        lines.push(format!(
            "已提交 {} 个到订阅源（跳过 {} · 目标缺失 {}）",
            d["submitted"].as_u64().unwrap_or(0),
            d["skipped"].as_u64().unwrap_or(0),
            d["missing"].as_u64().unwrap_or(0)
        ));
        for r in d["results"].as_array().cloned().unwrap_or_default() {
            let what = if r["status"].as_str() == Some("ok") {
                format!("→ {}", r["sourceDir"].as_str().unwrap_or(""))
            } else {
                r["reason"].as_str().unwrap_or(r["status"].as_str().unwrap_or("")).to_string()
            };
            lines.push(format!("  {:<28} {}", r["name"].as_str().unwrap_or(""), what));
        }
        return lines.join("\n");
    }
    if d["skipped"].as_bool().unwrap_or(false) {
        return d["reason"].as_str().unwrap_or("").to_string();
    }
    format!(
        "已提交到订阅源: {}\n目标实文件已删除{}",
        d["sourceDir"].as_str().unwrap_or(""),
        match d["relinked"].as_str().unwrap_or("") {
            "" => "（未重建链接）".to_string(),
            r => format!("，改回链接（{}）", r),
        }
    )
}

pub fn render_show(d: &Value, _ctx: &Value) -> String {
    let mut lines: Vec<String> = Vec::new();
    lines.push(d["name"].as_str().unwrap_or("").to_string());
    lines.push(format!(
        "  来源: {}",
        match d["source"].as_str().unwrap_or("") {
            "" => "（不在订阅源，可 skill submit）",
            s => s,
        }
    ));
    if let Some(dir) = d["dir"].as_str().filter(|s| !s.is_empty()) {
        lines.push(format!("  目录: {}", dir));
    }
    let also_in: Vec<String> = d["alsoIn"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|x| x.as_str().map(|y| y.to_string()))
        .collect();
    if !also_in.is_empty() {
        lines.push(format!("  同时存在于: {}", also_in.join(", ")));
    }
    lines.push(format!("  描述: {}", d["description"].as_str().unwrap_or("")));
    if let Some(u) = d["upstream"].as_object().filter(|_| !d["upstream"].is_null()) {
        let spec = u.get("spec").and_then(|s| s.as_str()).unwrap_or("");
        let r = u.get("ref").and_then(|s| s.as_str()).unwrap_or("");
        lines.push(format!(
            "  上游: {}{}",
            if spec.is_empty() { "（无，手写定义或软链）" } else { spec },
            if r.is_empty() { String::new() } else { format!("@{}", r) }
        ));
        if let Some(hash) = u.get("hash").and_then(|s| s.as_str()).filter(|s| !s.is_empty()) {
            lines.push(format!("  版本: {}", hash.chars().take(8).collect::<String>()));
        }
        let imported = u.get("importedAt").and_then(|s| s.as_str()).unwrap_or("—");
        let updated = u.get("updatedAt").and_then(|s| s.as_str()).unwrap_or("—");
        if !imported.is_empty() && imported != "—" {
            lines.push(format!("  导入: {}  ·  更新: {}", imported, updated));
        }
        if let Some(link) = u.get("link").and_then(|s| s.as_str()).filter(|s| !s.is_empty()) {
            lines.push(format!("  软链: {}", link));
        }
    }
    let outline = d["outline"].as_array().cloned().unwrap_or_default();
    if !outline.is_empty() {
        let sections = d.pointer("/stats/sections").and_then(|s| s.as_u64()).unwrap_or(outline.len() as u64);
        let line_count = d.pointer("/stats/lines").and_then(|s| s.as_u64());
        lines.push(format!(
            "  结构（{} 节 · {} 行）:",
            sections,
            line_count.map(|l| l.to_string()).unwrap_or_else(|| "?".into())
        ));
        for h in &outline {
            let level = h["level"].as_u64().unwrap_or(1) as usize;
            lines.push(format!(
                "    {}{} {}",
                "  ".repeat(level - 1),
                "#".repeat(level),
                h["text"].as_str().unwrap_or("")
            ));
        }
    }
    match d["conflict"].as_object() {
        Some(c) if !c.get("same").and_then(|s| s.as_bool()).unwrap_or(false) => {
            lines.push(format!(
                "  ! 跨源冲突: 同名 skill 在多个订阅源且内容不同（{}）",
                source_labels(&d.pointer("/conflict/sources").cloned().unwrap_or(json!([])))
            ));
            lines.push("    迁移会 blocked，先解决订阅或用 --source <路径> 指定用哪一份。".into());
        }
        Some(_) => {
            lines.push(format!(
                "  · 重复订阅（内容一致）: {}",
                source_labels(&d.pointer("/conflict/sources").cloned().unwrap_or(json!([])))
            ));
        }
        None => {}
    }
    lines.push("  平台安装状态（skill hub migrate <name> --platform <id> --to user|global|project）：".into());
    for c in d["cells"].as_array().cloned().unwrap_or_default() {
        let head = format!(
            "{}·{}",
            scope_mark(c["scope"].as_str().unwrap_or("")),
            c["platformName"].as_str().unwrap_or(c["platform"].as_str().unwrap_or(""))
        );
        let state = if c["on"].as_bool().unwrap_or(false) {
            match c["linkType"].as_str().unwrap_or("") {
                "" => "实体副本",
                lt => lt,
            }
        } else {
            "未安装"
        };
        lines.push(format!("    {:<22} {}  {}", head, state, c["dir"].as_str().unwrap_or("")));
    }
    if !also_in.is_empty() {
        lines.push(String::new());
        lines.push("  提示：同名 skill 出现在多个订阅源里，迁移以「当前主源」为准。".into());
    }
    lines.join("\n")
}

use serde_json::json;

pub fn render_purge(d: &Value, _ctx: &Value) -> String {
    let dry_run = d["dryRun"].as_bool().unwrap_or(false);
    if let Some(results) = d["results"].as_array().cloned().filter(|r| !r.is_empty()).or_else(|| {
        // 单条也可能有 results（批量形状）；单条走 else
        if d.get("results").map(|r| r.is_array()).unwrap_or(false) {
            d["results"].as_array().cloned()
        } else {
            None
        }
    }) {
        let mut lines: Vec<String> = Vec::new();
        if dry_run {
            lines.push(format!("预演（--dry-run，未改动磁盘）: 共 {} 个 skill", results.len()));
        } else {
            lines.push(format!(
                "已彻底删除 {}/{} 个",
                d["purged"].as_u64().unwrap_or(0),
                results.len()
            ));
        }
        for r in &results {
            match r["status"].as_str().unwrap_or("") {
                "ok" => {
                    if r["dryRun"].as_bool().unwrap_or(false) {
                        let targets = r.pointer("/plan/targets").and_then(|t| t.as_array()).map(|a| a.len()).unwrap_or(0);
                        let sources = r.pointer("/plan/sources").and_then(|t| t.as_array()).map(|a| a.len()).unwrap_or(0);
                        lines.push(format!("  预演    {}（安装 {} 处 · 订阅源 {} 份）", r["name"].as_str().unwrap_or(""), targets, sources));
                    } else {
                        lines.push(format!(
                            "  已删除  {}（{} 处）",
                            r["name"].as_str().unwrap_or(""),
                            r["removed"].as_array().map(|a| a.len()).unwrap_or(0)
                        ));
                    }
                }
                "blocked" => lines.push(format!("  已阻止  {}: {}", r["name"].as_str().unwrap_or(""), r["reason"].as_str().unwrap_or(""))),
                "error" => lines.push(format!("  失败    {}: {}", r["name"].as_str().unwrap_or(""), r["reason"].as_str().unwrap_or(""))),
                other => lines.push(format!("  {}: {}", r["name"].as_str().unwrap_or(""), other)),
            }
        }
        if d["status"].as_str() == Some("partial") {
            lines.push("部分完成——被阻止的多含实体副本，确认后加 --force 重跑那几个。".into());
        }
        return lines.join("\n");
    }
    let mut lines: Vec<String> = Vec::new();
    if d["status"].as_str() == Some("blocked") {
        lines.push(format!("已阻止: {}", d["reason"].as_str().unwrap_or("")));
    } else if dry_run {
        lines.push(format!(
            "预演（--dry-run，未改动磁盘）: 将彻底删除 {}",
            d.pointer("/plan/name").and_then(|n| n.as_str()).unwrap_or("")
        ));
    } else {
        lines.push(format!(
            "已彻底删除 {}（{} 处）",
            d["name"].as_str().unwrap_or(""),
            d["removed"].as_array().map(|a| a.len()).unwrap_or(0)
        ));
    }
    lines.push(if dry_run || d["status"].as_str() == Some("blocked") { "  将删除:" } else { "  已删除:" }.into());
    let plan = d["plan"].clone();
    for s in plan["sources"].as_array().cloned().unwrap_or_default() {
        lines.push(format!("    订阅源  {}  →  {}", s["source"].as_str().unwrap_or(""), s["dir"].as_str().unwrap_or("")));
    }
    for c in plan["targets"].as_array().cloned().unwrap_or_default() {
        lines.push(format!(
            "    安装位置  {}·{}  {}{}",
            scope_mark(c["scope"].as_str().unwrap_or("")),
            c["platform"].as_str().unwrap_or(""),
            c["path"].as_str().unwrap_or(""),
            if !c["linkType"].as_str().unwrap_or("").is_empty() { "（链接）" } else { "（实体副本）" }
        ));
    }
    let empty = plan["sources"].as_array().map(|a| a.is_empty()).unwrap_or(true)
        && plan["targets"].as_array().map(|a| a.is_empty()).unwrap_or(true);
    if empty {
        lines.push("    （无）".into());
    }
    if d["status"].as_str() == Some("blocked") {
        lines.push(String::new());
        lines.push("确认无误后加 --force 执行。".into());
    }
    lines.join("\n")
}

pub fn render_dedupe(d: &Value, _ctx: &Value) -> String {
    let mut lines: Vec<String> = Vec::new();
    if d["status"].as_str() == Some("blocked") {
        lines.push(format!("已阻止: {}", d["reason"].as_str().unwrap_or("")));
    } else if d["dryRun"].as_bool().unwrap_or(false) {
        lines.push(format!(
            "预演（--dry-run，未改动磁盘）: 唯一化 {}",
            d.pointer("/plan/name").and_then(|n| n.as_str()).unwrap_or("")
        ));
    } else if let Some(note) = d["note"].as_str().filter(|n| !n.is_empty()) {
        lines.push(format!("{}: {}", note, d["name"].as_str().unwrap_or("")));
    } else {
        lines.push(format!("已唯一化 {}（--as {}）", d["name"].as_str().unwrap_or(""), d["as"].as_str().unwrap_or("")));
    }
    let plan = d["plan"].clone();
    lines.push(format!(
        "  准份  {}  {}",
        plan.pointer("/winner/md5").and_then(|m| m.as_str()).unwrap_or("").chars().take(8).collect::<String>(),
        plan.pointer("/winner/dir").and_then(|m| m.as_str()).unwrap_or("")
    ));
    let pending = d["dryRun"].as_bool().unwrap_or(false) || d["status"].as_str() == Some("blocked");
    lines.push(if pending {
        format!("  其余将 --as {}:", plan["as"].as_str().unwrap_or("link"))
    } else {
        "  其余已处理:".to_string()
    });
    for o in plan["others"].as_array().cloned().unwrap_or_default() {
        let mut mark = String::new();
        if !pending {
            for x in d["linked"].as_array().cloned().unwrap_or_default() {
                if x["dir"].as_str() == o["dir"].as_str() {
                    mark = format!("（{}）", x["linkType"].as_str().unwrap_or(""));
                }
            }
            for x in d["removed"].as_array().cloned().unwrap_or_default() {
                if x["dir"].as_str() == o["dir"].as_str() {
                    if x["degraded"].as_bool().unwrap_or(false) {
                        mark = format!("（建链失败，已回填副本: {}）", x["reason"].as_str().unwrap_or(""));
                    } else {
                        mark = String::new();
                    }
                }
            }
        }
        lines.push(format!(
            "    {}  {}{}",
            o["md5"].as_str().unwrap_or("").chars().take(8).collect::<String>(),
            o["dir"].as_str().unwrap_or(""),
            mark
        ));
    }
    if plan["others"].as_array().map(|a| a.is_empty()).unwrap_or(true) {
        lines.push("    （无）".into());
    }
    if d["status"].as_str() == Some("blocked") {
        lines.push(String::new());
        lines.push("确认无误后加 --force 执行。".into());
    }
    lines.join("\n")
}

pub fn render_dedupe_all(d: &Value, _ctx: &Value) -> String {
    if let Some(note) = d["note"].as_str().filter(|n| !n.is_empty()) {
        return note.to_string();
    }
    let mut lines: Vec<String> = Vec::new();
    if d["status"].as_str() == Some("blocked") {
        lines.push(format!("已阻止: {}", d["reason"].as_str().unwrap_or("")));
    } else if d["dryRun"].as_bool().unwrap_or(false) {
        lines.push("预演（--dry-run，未改动磁盘）: 批量唯一化计划".into());
    } else {
        lines.push(format!(
            "已批量唯一化 {} 组（--as {}）",
            d.pointer("/totals/groups").and_then(|g| g.as_u64()).unwrap_or(0),
            d["as"].as_str().unwrap_or("")
        ));
    }
    let pending = d["status"].as_str() == Some("blocked") || d["dryRun"].as_bool().unwrap_or(false);
    for g in d["groups"].as_array().cloned().unwrap_or_default() {
        lines.push(format!(
            "  {}{}",
            g["name"].as_str().unwrap_or(""),
            if g["noPrimary"].as_bool().unwrap_or(false) { "（无主源实文件，取第一份为准）" } else { "" }
        ));
        lines.push(format!(
            "    准份  {}  {}",
            g.pointer("/winner/md5").and_then(|m| m.as_str()).unwrap_or("").chars().take(8).collect::<String>(),
            g.pointer("/winner/dir").and_then(|m| m.as_str()).unwrap_or("")
        ));
        if pending {
            for o in g["others"].as_array().cloned().unwrap_or_default() {
                lines.push(format!(
                    "    其余将 --as {}  {}  {}",
                    d["as"].as_str().unwrap_or(""),
                    o["md5"].as_str().unwrap_or("").chars().take(8).collect::<String>(),
                    o["dir"].as_str().unwrap_or("")
                ));
            }
            continue;
        }
        for l in g["linked"].as_array().cloned().unwrap_or_default() {
            lines.push(format!("    → 链接（{}）  {}", l["linkType"].as_str().unwrap_or(""), l["dir"].as_str().unwrap_or("")));
        }
        for r in g["removed"].as_array().cloned().unwrap_or_default() {
            lines.push(format!(
                "    → 删除{}  {}",
                if r["degraded"].as_bool().unwrap_or(false) {
                    format!("（建链失败，已回填副本: {}）", r["reason"].as_str().unwrap_or(""))
                } else {
                    String::new()
                },
                r["dir"].as_str().unwrap_or("")
            ));
        }
        for s in g["skipped"].as_array().cloned().unwrap_or_default() {
            lines.push(format!("    → 跳过（{}）  {}", s["reason"].as_str().unwrap_or(""), s["dir"].as_str().unwrap_or("")));
        }
    }
    let groups = d["groups"].as_array().cloned().unwrap_or_default();
    if groups.is_empty() {
        lines.push("    （无）".into());
    }
    let ignored: Vec<String> = d["ignored"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|x| x.as_str().map(|y| y.to_string()))
        .collect();
    if !ignored.is_empty() {
        lines.push(format!("  点名但已不在重复/冲突里（跳过）: {}", ignored.join(" , ")));
    }
    if !pending && d["totals"].is_object() {
        lines.push(format!(
            "  合计：{} 组，转链接 {}，删除 {}，跳过 {}",
            d.pointer("/totals/groups").and_then(|g| g.as_u64()).unwrap_or(0),
            d.pointer("/totals/linked").and_then(|g| g.as_u64()).unwrap_or(0),
            d.pointer("/totals/removed").and_then(|g| g.as_u64()).unwrap_or(0),
            d.pointer("/totals/skipped").and_then(|g| g.as_u64()).unwrap_or(0)
        ));
    }
    if d["status"].as_str() == Some("blocked") {
        lines.push(String::new());
        lines.push("确认无误后加 --force 执行。".into());
    }
    lines.join("\n")
}

pub fn render_adapters(list: &Value, _ctx: &Value) -> String {
    let arr = list.as_array().cloned().unwrap_or_default();
    let w = arr.iter().map(|a| a["id"].as_str().unwrap_or("").len()).max().unwrap_or(0);
    arr.iter()
        .map(|a| {
            let enabled = a["enabled"].as_bool().unwrap_or(false);
            let is_default = a["isDefault"].as_bool().unwrap_or(false);
            format!(
                "{:<w$}  {}{}  {}\n  {:<w$}  项目  {}\n  {:<w$}  用户  {}",
                a["id"].as_str().unwrap_or(""),
                if enabled { "[启用]" } else { "[   ]" },
                if is_default { " [默认]" } else { "" },
                a["name"].as_str().unwrap_or(""),
                "",
                a["projectDir"].as_str().unwrap_or(""),
                "",
                a["userDir"].as_str().unwrap_or(""),
                w = w
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn render_search(d: &Value, _ctx: &Value) -> String {
    let results = d["results"].as_array().cloned().unwrap_or_default();
    if results.is_empty() {
        let owner = d["owner"].as_str().unwrap_or("");
        return format!(
            "（没有匹配「{}」的结果{}）",
            d["query"].as_str().unwrap_or(""),
            if owner.is_empty() { String::new() } else { format!("，owner={}", owner) }
        );
    }
    let mut lines: Vec<String> = Vec::new();
    let owner = d["owner"].as_str().unwrap_or("");
    lines.push(format!(
        "skills.sh 搜索「{}」{}，{} 条:",
        d["query"].as_str().unwrap_or(""),
        if owner.is_empty() { String::new() } else { format!("（owner: {}）", owner) },
        results.len()
    ));
    for r in &results {
        lines.push(format!(
            "{:<32} {:<44} {} 次安装",
            r["name"].as_str().unwrap_or(""),
            r["source"].as_str().unwrap_or(""),
            r["installs"]
        ));
    }
    lines.push(String::new());
    lines.push("导入到远程订阅：nx-rh-rs skill hub remote import <上面任意 source>".into());
    lines.join("\n")
}

pub fn render_remote_hub(d: &Value, _ctx: &Value) -> String {
    let skills = d["skills"].as_array().cloned().unwrap_or_default();
    if skills.is_empty() {
        return [
            format!("远程订阅还是空的: {}", d["dir"].as_str().unwrap_or("")),
            "导入: nx-rh-rs skill hub remote import <owner/repo|git URL>".into(),
            "手写定义: nx-rh-rs skill hub remote add <name>".into(),
            "软链: nx-rh-rs skill hub remote link <name> <目标目录>".into(),
        ]
        .join("\n");
    }
    let mut lines: Vec<String> = Vec::new();
    lines.push(format!(
        "远程订阅: {}  ({} 个 skill)",
        d["dir"].as_str().unwrap_or(""),
        skills.len()
    ));
    for s in &skills {
        let from = if !s["linkType"].as_str().unwrap_or("").is_empty() {
            format!("软链 → {}", s["dir"].as_str().unwrap_or(""))
        } else if s["manual"].as_bool().unwrap_or(false) {
            "（手写定义）".to_string()
        } else {
            format!(
                "{}{}",
                s["spec"].as_str().unwrap_or(""),
                match s["ref"].as_str().unwrap_or("") {
                    "" => String::new(),
                    r => format!("@{}", r),
                }
            )
        };
        lines.push(format!(
            "{:<28} {}  {}  ·  更新于 {}",
            s["name"].as_str().unwrap_or(""),
            s["hash"].as_str().unwrap_or("").chars().take(8).collect::<String>(),
            from,
            s["updatedAt"].as_str().unwrap_or("—")
        ));
    }
    lines.join("\n")
}

pub fn render_remote_update(d: &Value, _ctx: &Value) -> String {
    if let Some(note) = d["note"].as_str().filter(|n| !n.is_empty()) {
        return note.to_string();
    }
    let mut lines: Vec<String> = vec!["远程订阅 更新:".into()];
    for r in d["results"].as_array().cloned().unwrap_or_default() {
        match r["status"].as_str().unwrap_or("") {
            "updated" => lines.push(format!(
                "  ~ {}  {} → {}",
                r["name"].as_str().unwrap_or(""),
                r["from"].as_str().unwrap_or("").chars().take(8).collect::<String>(),
                r["hash"].as_str().unwrap_or("").chars().take(8).collect::<String>()
            )),
            "unchanged" => lines.push(format!("  = {}  无变化", r["name"].as_str().unwrap_or(""))),
            "removed" => lines.push(format!("  - {}  {}", r["name"].as_str().unwrap_or(""), r["reason"].as_str().unwrap_or(""))),
            "skipped" => lines.push(format!("  · {}  {}", r["name"].as_str().unwrap_or(""), r["reason"].as_str().unwrap_or(""))),
            _ => lines.push(format!("  ! {}  失败: {}", r["name"].as_str().unwrap_or(""), r["error"].as_str().unwrap_or(""))),
        }
    }
    if d["results"].as_array().map(|a| a.is_empty()).unwrap_or(true) {
        lines.push("  （没有可更新的 skill）".into());
    }
    lines.join("\n")
}

pub fn render_refresh(d: &Value, _ctx: &Value) -> String {
    if let Some(note) = d["note"].as_str().filter(|n| !n.is_empty()) {
        return note.to_string();
    }
    let mut lines: Vec<String> = vec!["订阅源更新检查:".into()];
    let results = d["results"].as_array().cloned().unwrap_or_default();
    for r in &results {
        if let Some(err) = r["error"].as_str().filter(|e| !e.is_empty()) {
            lines.push(format!("  ! {}  {}", r["source"].as_str().unwrap_or(""), err));
            continue;
        }
        if r["remote"].as_bool().unwrap_or(false) {
            let clean = r["clean"].as_bool().unwrap_or(false);
            lines.push(format!(
                "  {} {}  {}",
                if clean { "=" } else { "~" },
                r["source"].as_str().unwrap_or(""),
                if clean { "（无变化）".to_string() } else { format!("台账已对齐 {} 个", r["aligned"].as_u64().unwrap_or(0)) }
            ));
            continue;
        }
        if r["firstTime"].as_bool().unwrap_or(false) {
            let added = r["added"].as_array().map(|a| a.len()).unwrap_or(0);
            lines.push(format!(
                "  + {}  首次记录基准（{} 个 skill）",
                r["source"].as_str().unwrap_or(""),
                added
            ));
            continue;
        }
        let clean = r["clean"].as_bool().unwrap_or(false);
        lines.push(format!(
            "  {} {}  {}",
            if clean { "=" } else { "~" },
            r["source"].as_str().unwrap_or(""),
            if clean { "（无变化）" } else { "" }
        ));
        if let Some(added) = r["added"].as_array() {
            if !added.is_empty() {
                lines.push(format!("    + 新增: {}", strs(added)));
            }
        }
        if let Some(removed) = r["removed"].as_array() {
            if !removed.is_empty() {
                lines.push(format!("    - 移除: {}", strs(removed)));
            }
        }
        if let Some(changed) = r["changed"].as_array() {
            if !changed.is_empty() {
                lines.push(format!("    ~ 变更: {}", strs(changed)));
            }
        }
    }
    if results.is_empty() {
        lines.push("  （没有可检查的订阅源）".into());
    }
    lines.join("\n")
}

fn strs(arr: &[Value]) -> String {
    arr.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>().join(", ")
}
