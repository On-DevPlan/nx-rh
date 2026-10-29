// 工作树模块 —— 与 modules/worktrees/index.js + renders.js 对齐。

pub mod service;

use serde_json::{json, Value};

use crate::core::errors::Res;
use crate::runtime::spec::{Action, ArgSpec, FlagSpec};

fn short_head(h: &str) -> String {
    h.chars().take(8).collect()
}

fn wt_bits(w: &Value) -> String {
    let mut t: Vec<String> = Vec::new();
    if w["isMain"].as_bool().unwrap_or(false) {
        t.push("主".into());
    }
    if w["dirty"].as_bool().unwrap_or(false) {
        t.push("改动".into());
    }
    if w["detached"].as_bool().unwrap_or(false) {
        t.push("分离HEAD".into());
    }
    if let Some(a) = w["ahead"].as_u64().filter(|a| *a > 0) {
        t.push(format!("↑{}", a));
    }
    if let Some(b) = w["behind"].as_u64().filter(|b| *b > 0) {
        t.push(format!("↓{}", b));
    }
    if let Some(m) = w["extMissing"].as_u64().filter(|m| *m > 0) {
        t.push(format!("缺扩展{}", m));
    }
    if t.is_empty() {
        String::new()
    } else {
        format!("  [{}]", t.join(" "))
    }
}

fn render_wt_list(d: &Value) -> String {
    if !d["main"]["git"].as_bool().unwrap_or(false) {
        return format!("（{} 不是 git 仓库）", d["main"]["path"].as_str().unwrap_or(""));
    }
    let worktrees = d["worktrees"].as_array().cloned().unwrap_or_default();
    let mut lines: Vec<String> = Vec::new();
    lines.push(format!("主仓库: {}", d["main"]["path"].as_str().unwrap_or("")));
    lines.push(format!(
        "基础分支: {}    工作树根: {}",
        d.pointer("/config/baseBranch").and_then(|b| b.as_str()).unwrap_or(""),
        d.pointer("/config/worktreeRoot").and_then(|b| b.as_str()).unwrap_or("")
    ));
    lines.push(format!("共 {} 个工作树", worktrees.len()));
    for w in &worktrees {
        lines.push(format!(
            "  {:<34}{}{}",
            w["branch"].as_str().unwrap_or("(detached)"),
            short_head(w["head"].as_str().unwrap_or("")),
            wt_bits(w)
        ));
        lines.push(format!("    {}", w["path"].as_str().unwrap_or("")));
    }
    lines.join("\n")
}

fn render_wt(w: &Value) -> String {
    let mut lines: Vec<String> = Vec::new();
    lines.push(format!("{}{}", w["name"].as_str().unwrap_or(""), wt_bits(w)));
    lines.push(format!("  路径:   {}", w["path"].as_str().unwrap_or("")));
    lines.push(format!(
        "  分支:   {}    HEAD: {}",
        w["branch"].as_str().unwrap_or("(detached)"),
        short_head(w["head"].as_str().unwrap_or(""))
    ));
    if let Some(log) = w["log"].as_str().filter(|l| !l.is_empty()) {
        lines.push(String::new());
        lines.push("  最近提交:".into());
        for l in log.lines() {
            lines.push(format!("    {}", l));
        }
    }
    if let Some(items) = w.pointer("/extensions/items").and_then(|i| i.as_array()).filter(|i| !i.is_empty()) {
        lines.push(String::new());
        lines.push("  扩展文件:".into());
        for e in items {
            let state = if !e["present"].as_bool().unwrap_or(false) {
                "缺失"
            } else if e["upToDate"].as_bool().unwrap_or(true) {
                "  "
            } else {
                "差异"
            };
            let label = e["label"].as_str().unwrap_or("");
            lines.push(format!(
                "    {}  {}{}",
                state,
                e["rel"].as_str().unwrap_or(""),
                if label.is_empty() { String::new() } else { format!("  ({})", label) }
            ));
        }
    }
    lines.join("\n")
}

fn cd_line(r: &Value) -> String {
    [
        format!(
            "已{}: {}",
            if r["branch"].as_str().map(|b| !b.is_empty()).unwrap_or(false) { "创建" } else { "挂载" },
            r["branch"].as_str().unwrap_or(r["name"].as_str().unwrap_or(""))
        ),
        format!("  路径: {}", r["path"].as_str().unwrap_or("")),
        String::new(),
        format!("cd \"{}\"", r["path"].as_str().unwrap_or("")),
        String::new(),
        "进入后查看主项目变更与只读参考文档: nx-rh-rs wt context".into(),
    ]
    .join("\n")
}

fn render_remove(r: &Value) -> String {
    if r["status"].as_str() == Some("blocked") {
        return format!("未删除: {} —— {}", r["name"].as_str().unwrap_or(""), r["reason"].as_str().unwrap_or(""));
    }
    let mut lines: Vec<String> = vec![format!("已移除工作树: {}", r["removed"].as_str().unwrap_or(""))];
    if r["branchDeleted"].as_bool().unwrap_or(false) {
        lines.push("关联分支已删除".into());
    }
    if let Some(kept) = r["branchKept"].as_str().filter(|k| !k.is_empty()) {
        lines.push(format!("分支保留: {}（{}）", kept, r["note"].as_str().unwrap_or("")));
    }
    lines.join("\n")
}

fn render_config(c: &Value) -> String {
    let mut lines: Vec<String> = Vec::new();
    lines.push(format!(
        "主仓库: {}{}",
        c["main"].as_str().unwrap_or(""),
        if c["git"].as_bool().unwrap_or(false) { String::new() } else { "（非 git 仓库）".into() }
    ));
    if let Some(cw) = c["currentWorktree"].as_str().filter(|s| !s.is_empty()) {
        lines.push(format!("当前工作树: {}", cw));
    }
    lines.push(format!(
        "  分支前缀:   {}",
        c["branchPrefix"].as_str().unwrap_or("")
    ));
    lines.push(format!("  基础分支:   {}", c["baseBranch"].as_str().unwrap_or("")));
    lines.push(format!("  工作树根:   {}", c["worktreeRoot"].as_str().unwrap_or("")));
    lines.join("\n")
}

fn render_init(r: &Value) -> String {
    let mut lines: Vec<String> = vec!["工作树机制已就绪".into(), format!("  主仓库: {}", r["main"].as_str().unwrap_or(""))];
    if let Some(gi) = r["gitignoreAdded"].as_str().filter(|g| !g.is_empty()) {
        lines.push(format!("  已登记 .gitignore: {}", gi));
    }
    lines.push(format!(
        "  工作树根: {}",
        r.pointer("/config/worktreeRoot").and_then(|w| w.as_str()).unwrap_or("")
    ));
    lines.push(String::new());
    lines.push("下一步: nx-rh-rs wt add \"<你要做的事>\"".into());
    lines.join("\n")
}

fn render_context(c: &Value) -> String {
    if !c["git"].as_bool().unwrap_or(false) {
        return format!("（{} 不是 git 仓库）", c["project"].as_str().unwrap_or(""));
    }
    let m = &c["main"];
    let mut lines: Vec<String> = Vec::new();
    lines.push(format!("主项目: {}", m["path"].as_str().unwrap_or("")));
    lines.push(format!(
        "  分支: {}   HEAD: {}   {}",
        m["branch"].as_str().unwrap_or("(detached)"),
        short_head(m["head"].as_str().unwrap_or("")),
        if m["dirty"].as_bool().unwrap_or(false) { "有未提交改动" } else { "干净" }
    ));
    lines.push(String::new());
    for l in m["status"].as_str().unwrap_or("").lines() {
        lines.push(format!("  {}", l));
    }
    lines.push(String::new());
    lines.push("  最近提交:".into());
    for l in m["log"].as_str().unwrap_or("").lines() {
        lines.push(format!("    {}", l));
    }
    if let Some(w) = c["currentWorktree"].as_object().filter(|_| !c["currentWorktree"].is_null()) {
        let d = &w["divergence"];
        lines.push(String::new());
        lines.push(format!("当前工作树: {}", w["path"].as_str().unwrap_or("")));
        lines.push(format!(
            "  分支: {}   {}   相对 {}: ↑{} ↓{}",
            w["branch"].as_str().unwrap_or("(detached)"),
            if w["dirty"].as_bool().unwrap_or(false) { "有未提交改动" } else { "干净" },
            d["relativeTo"].as_str().unwrap_or(""),
            d["ahead"].as_str().map(|_| "?".to_string()).unwrap_or_else(|| d["ahead"].to_string()),
            d["behind"].as_str().map(|_| "?".to_string()).unwrap_or_else(|| d["behind"].to_string()),
        ));
    }
    let em = &c["extensions"]["main"];
    lines.push(String::new());
    lines.push(format!(
        "扩展文件（主项目）: 登记 {}，在场 {}，变更 {}，缺失 {}",
        em["registered"], em["present"], em["changed"], em["missing"]
    ));
    if let Some(eh) = c["extensions"]["here"].as_object().filter(|_| !c["extensions"]["here"].is_null()) {
        lines.push(format!(
            "扩展文件（当前树）: 一致 {}，差异 {}，缺失 {}",
            eh["upToDate"], eh["differs"], eh["missing"]
        ));
    }
    let suggested = c["suggested"].as_array().cloned().unwrap_or_default();
    if !suggested.is_empty() {
        lines.push(String::new());
        lines.push("建议指令:".into());
        for s in &suggested {
            lines.push(format!("  - {}", s.as_str().unwrap_or("")));
        }
    }
    lines.join("\n")
}

fn render_ext_list(d: &Value) -> String {
    let head = if d["isMain"].as_bool().unwrap_or(false) {
        format!("评估目标（主仓库）: {}", d["target"].as_str().unwrap_or(""))
    } else {
        format!("评估目标（工作树）: {}", d["target"].as_str().unwrap_or(""))
    };
    let items = d["items"].as_array().cloned().unwrap_or_default();
    if items.is_empty() {
        return format!(
            "{}\n（暂无扩展文件，用 nx-rh-rs wt ext add <绝对路径> 登记，或 wt ext discover 发现）",
            head
        );
    }
    let mut lines = vec![head];
    let is_main = d["isMain"].as_bool().unwrap_or(false);
    for e in &items {
        let label = e["label"].as_str().unwrap_or("");
        let state = if !e["present"].as_bool().unwrap_or(false) {
            "缺失".to_string()
        } else if is_main {
            if e["changed"].as_bool().unwrap_or(false) { "变更" } else { "一致" }.to_string()
        } else if e["upToDate"].as_bool().unwrap_or(false) {
            "一致".to_string()
        } else {
            "差异".to_string()
        };
        lines.push(format!(
            "  {}  {}{}",
            state,
            e["rel"].as_str().unwrap_or(""),
            if label.is_empty() { String::new() } else { format!("  ({})", label) }
        ));
    }
    let s = &d["summary"];
    lines.push(String::new());
    lines.push(if is_main {
        format!(
            "登记 {}，在场 {}，变更 {}，缺失 {}",
            s["registered"], s["present"], s["changed"], s["missing"]
        )
    } else {
        format!(
            "登记 {}，一致 {}，差异 {}，缺失 {}",
            s["registered"], s["upToDate"], s["differs"], s["missing"]
        )
    });
    lines.join("\n")
}

fn render_discover(d: &Value) -> String {
    let s = &d["summary"];
    let mut lines: Vec<String> = Vec::new();
    if d["apply"].as_bool().unwrap_or(false) {
        lines.push(format!("已登记 {} 个扩展文件", s["added"]));
    } else {
        lines.push(format!(
            "发现 {} 个候选，可登记 {} 个，已登记 {} 个",
            s["found"], s["registrable"], s["alreadyRegistered"]
        ));
    }
    for p in d["proposals"].as_array().cloned().unwrap_or_default() {
        let mark = if p["alreadyRegistered"].as_bool().unwrap_or(false) {
            "已登记"
        } else if p["exists"].as_bool().unwrap_or(false) {
            "可登记"
        } else {
            "不存在"
        };
        lines.push(format!(
            "  {:<4} [{}] {} ({})",
            mark,
            p["source"].as_str().unwrap_or(""),
            p["rel"].as_str().unwrap_or(""),
            p["kind"].as_str().unwrap_or("-")
        ));
    }
    if !d["apply"].as_bool().unwrap_or(false) {
        lines.push(String::new());
        lines.push("确认登记全部候选：nx-rh-rs wt ext discover --apply".into());
    }
    lines.join("\n")
}

fn render_ext_added(r: &Value) -> String {
    format!(
        "已登记扩展文件: {}  [{}]{}",
        r["relPath"].as_str().unwrap_or(""),
        r["kind"].as_str().unwrap_or(""),
        match r["label"].as_str().unwrap_or("") {
            "" => String::new(),
            l => format!("  ({})", l),
        }
    )
}

fn render_rebase(r: &Value) -> String {
    match r["status"].as_str().unwrap_or("") {
        "ok" => format!("已 rebase 到 {}: {}", r["base"].as_str().unwrap_or(""), r["path"].as_str().unwrap_or("")),
        "conflict" => format!(
            "冲突，已自动 abort: {} -> {}\n{}",
            r["path"].as_str().unwrap_or(""),
            r["base"].as_str().unwrap_or(""),
            r["output"].as_str().unwrap_or("")
        ),
        _ => format!("未执行: {} —— {}", r["path"].as_str().unwrap_or(""), r["reason"].as_str().unwrap_or("")),
    }
}

fn render_fanout(r: &Value) -> String {
    match r["status"].as_str().unwrap_or("") {
        "ok" => format!(
            "Fanout 完成: {} 个 -> {}\n  {}",
            r["completed"].as_array().map(|a| a.len()).unwrap_or(0),
            r["base"].as_str().unwrap_or(""),
            r["completed"]
                .as_array()
                .map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join("\n  "))
                .unwrap_or_default()
        ),
        "conflict" => format!(
            "Fanout 在「{}」遇到冲突，已 abort；已完成: {}\n{}",
            r["failedAt"].as_str().unwrap_or(""),
            r["completed"]
                .as_array()
                .map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(", "))
                .unwrap_or_else(|| "无".into()),
            r["output"].as_str().unwrap_or("")
        ),
        "blocked" => {
            let mut lines: Vec<String> = vec![format!("Fanout 被阻止（基础 {}）:", r["base"].as_str().unwrap_or(""))];
            for p in r["plan"].as_array().cloned().unwrap_or_default() {
                let blockers: Vec<String> = p["blockers"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .iter()
                    .filter_map(|b| b.as_str().map(|s| s.to_string()))
                    .collect();
                lines.push(format!("  {}: {}", p["name"].as_str().unwrap_or(""), blockers.join("; ")));
            }
            lines.join("\n")
        }
        _ => {
            let plan = r["plan"].as_array().cloned().unwrap_or_default();
            let mut lines: Vec<String> = vec![format!(
                "Fanout 计划（基础 {}）：{} 个目标，{} 个不可执行",
                r["base"].as_str().unwrap_or(""),
                plan.len(),
                r["blockedCount"]
            )];
            for p in &plan {
                let blockers: Vec<String> = p["blockers"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .iter()
                    .filter_map(|b| b.as_str().map(|s| s.to_string()))
                    .collect();
                lines.push(format!(
                    "  {}  {} ({}){}",
                    if p["safe"].as_bool().unwrap_or(false) { "可执行" } else { "阻止" },
                    p["branch"].as_str().unwrap_or(""),
                    p["name"].as_str().unwrap_or(""),
                    if blockers.is_empty() { String::new() } else { format!(" — {}", blockers.join("; ")) }
                ));
            }
            lines.push(String::new());
            lines.push("确认执行: nx-rh-rs wt fanout --yes".into());
            lines.join("\n")
        }
    }
}

// ---- specs ----

fn sflag(name: &'static str, hint: &'static str) -> FlagSpec {
    FlagSpec { name, kind: "string", required: false, default: None, enum_values: None, hint }
}
fn bflag(name: &'static str) -> FlagSpec {
    FlagSpec { name, kind: "boolean", required: false, default: None, enum_values: None, hint: "" }
}
fn nflag(name: &'static str, default: u64, hint: &'static str) -> FlagSpec {
    FlagSpec { name, kind: "number", required: false, default: Some(json!(default)), enum_values: None, hint }
}
fn aarg(name: &'static str) -> ArgSpec {
    ArgSpec { name, required: true, rest: false }
}
fn oarg(name: &'static str) -> ArgSpec {
    ArgSpec { name, required: false, rest: false }
}

macro_rules! wt_action {
    ($id:expr, $cli:expr, $http:expr, $summary:expr, $args:expr, $flags:expr, $run:expr, $render:expr) => {
        Action {
            id: $id,
            cli: $cli,
            http: $http,
            summary: $summary,
            args: $args,
            flags: $flags,
            module: "worktrees",
            run: $run,
            render: $render,
        }
    };
}

use once_cell::sync::Lazy;

/// action 表（Lazy：Action 里含 Vec 字段，放不进 static 数组）。
pub fn actions() -> &'static Vec<Action> {
    static ACTIONS: Lazy<Vec<Action>> = Lazy::new(|| vec![
    wt_action!("wt.init", vec![vec!["wt", "init"]], Some(("POST", "/api/wt/init")),
        "初始化工作树机制：建根目录、按需登记 .gitignore", vec![], vec![sflag("root", "工作树根目录"), sflag("branch-prefix", ""), sflag("base-branch", "")],
        |ctx, _| service::init_worktree(ctx),
        Some(|d, _ctx| render_init(d))),
    wt_action!("wt.config.get", vec![vec!["wt", "config"]], Some(("GET", "/api/wt/config")),
        "查看工作树模块配置", vec![], vec![],
        |_, _| Ok(service::get_config()),
        Some(|d, _ctx| render_config(d))),
    wt_action!("wt.config.set", vec![vec!["wt", "config", "set"]], Some(("PATCH", "/api/wt/config")),
        "修改分支前缀 / 基础分支 / 工作树根", vec![], vec![sflag("root", "工作树根目录"), sflag("branch-prefix", ""), sflag("base-branch", "")],
        |ctx, _| service::set_config(ctx),
        Some(|d, _ctx| render_config(d))),
    wt_action!("wt.list", vec![vec!["wt", "list"]], Some(("GET", "/api/wt/list")),
        "工作树清单（含改动 / 领先落后 / 缺扩展）", vec![], vec![sflag("base", "基础分支")],
        |ctx, _| service::list_worktrees_with(ctx["base"].as_str().unwrap_or("")),
        Some(|d, _ctx| render_wt_list(d))),
    wt_action!("wt.get", vec![vec!["wt", "get"]], Some(("GET", "/api/wt/:ref")),
        "查看单个工作树详情（提交记录 / 扩展文件）", vec![aarg("ref")], vec![],
        |ctx, _| service::get_worktree(ctx["ref"].as_str().unwrap_or("")),
        Some(|d, _ctx| render_wt(d))),
    wt_action!("wt.add", vec![vec!["wt", "add"]], Some(("POST", "/api/wt")),
        "描述要做的事，创建分支与工作树", vec![aarg("description")], vec![sflag("name", "自定义会话名"), sflag("base", "起点分支"), sflag("root", "工作树根覆盖"), bflag("force")],
        |ctx, _| service::add_worktree(ctx),
        Some(|r, _ctx| cd_line(r))),
    wt_action!("wt.checkout", vec![vec!["wt", "checkout"]], Some(("POST", "/api/wt/checkout")),
        "把已存在的分支挂成新工作树", vec![aarg("branch")], vec![sflag("name", ""), sflag("root", ""), bflag("force")],
        |ctx, _| service::checkout_worktree(ctx),
        Some(|r, _ctx| cd_line(r))),
    wt_action!("wt.remove", vec![vec!["wt", "remove"]], Some(("DELETE", "/api/wt/:ref")),
        "移除工作树；--branch 连分支一起删，脏树需 --force", vec![aarg("ref")], vec![bflag("branch"), bflag("force")],
        |ctx, _| service::remove_worktree(
            ctx["ref"].as_str().unwrap_or(""),
            ctx["branch"].as_bool().unwrap_or(false),
            ctx["force"].as_bool().unwrap_or(false)
        ),
        Some(|r, _ctx| render_remove(r))),
    wt_action!("wt.switch", vec![vec!["wt", "switch"]], Some(("POST", "/api/wt/switch")),
        "取得进入工作树的 cd 指令", vec![aarg("ref")], vec![],
        |ctx, _| service::switch_worktree(ctx["ref"].as_str().unwrap_or("")),
        Some(|r, _ctx| format!("cd \"{}\"", r["path"].as_str().unwrap_or("")))),
    wt_action!("wt.open", vec![vec!["wt", "open"]], Some(("POST", "/api/wt/open")),
        "在系统文件管理器中打开工作树", vec![aarg("ref")], vec![],
        |ctx, _| service::open_worktree(ctx["ref"].as_str().unwrap_or("")),
        Some(|r, _ctx| format!("已打开: {}", r["opened"].as_str().unwrap_or("")))),
    wt_action!("wt.context", vec![vec!["wt", "context"]], Some(("GET", "/api/wt/context")),
        "一次性获取主项目的最新 git 上下文（分支/改动/领先落后/扩展）", vec![], vec![nflag("log", 5, "最近提交条数")],
        |ctx, _| service::get_context(ctx["log"].as_u64().unwrap_or(5)),
        Some(|d, _ctx| render_context(d))),
    wt_action!("wt.rebase", vec![vec!["wt", "rebase"]], Some(("POST", "/api/wt/rebase")),
        "把工作树 rebase 到主项目当前分支；脏树给 --message 自动提交", vec![aarg("ref")], vec![sflag("base", "基础分支"), sflag("message", "自动提交信息")],
        |ctx, _| service::rebase_worktree(ctx),
        Some(|r, _ctx| render_rebase(r))),
    wt_action!("wt.fanout", vec![vec!["wt", "fanout"]], Some(("POST", "/api/wt/fanout")),
        "把主项目当前分支同步（rebase）到全部工作树；先出计划，--yes 执行", vec![], vec![sflag("base", "基础分支"), bflag("yes")],
        |ctx, _| service::fanout(ctx["base"].as_str().unwrap_or(""), ctx["yes"].as_bool().unwrap_or(false)),
        Some(|r, _ctx| render_fanout(r))),
    wt_action!("wt.ext.list", vec![vec!["wt", "ext", "list"]], Some(("GET", "/api/wt/ext")),
        "扩展文件清单及其在主项目/当前工作树的状态", vec![], vec![sflag("target", "评估指定工作树")],
        |ctx, _| service::list_extensions(ctx["target"].as_str().unwrap_or("")),
        Some(|d, _ctx| render_ext_list(d))),
    wt_action!("wt.ext.add", vec![vec!["wt", "ext", "add"]], Some(("POST", "/api/wt/ext")),
        "按全路径登记一个被 git 忽略的文件/目录为扩展文件", vec![aarg("abspath")], vec![sflag("label", ""), bflag("force")],
        |ctx, _| service::add_extension(ctx),
        Some(|r, _ctx| render_ext_added(r))),
    wt_action!("wt.ext.discover", vec![vec!["wt", "ext", "discover"]], Some(("POST", "/api/wt/ext/discover")),
        "从 .gitignore 与 git 发现被忽略文件；默认只建议，--apply 登记", vec![], vec![bflag("apply")],
        |ctx, _| service::discover_extensions(ctx["apply"].as_bool().unwrap_or(false)),
        Some(|d, _ctx| render_discover(d))),
    wt_action!("wt.ext.get", vec![vec!["wt", "ext", "get"]], Some(("GET", "/api/wt/ext/:ref")),
        "查看单个扩展文件登记与当前状态", vec![aarg("ref")], vec![],
        |ctx, _| service::get_extension(ctx["ref"].as_str().unwrap_or("")),
        Some(|r, _ctx| render_ext_added(r))),
    wt_action!("wt.ext.update", vec![vec!["wt", "ext", "update"]], Some(("PATCH", "/api/wt/ext/:ref")),
        "修改扩展文件标签", vec![aarg("ref")], vec![sflag("label", "")],
        |ctx, _| service::update_extension(ctx["ref"].as_str().unwrap_or(""), ctx["label"].as_str().unwrap_or("")),
        Some(|r, _ctx| format!(
            "已更新: {}{}",
            r["relPath"].as_str().unwrap_or(""),
            match r["label"].as_str().unwrap_or("") {
                "" => String::new(),
                l => format!("  ({})", l),
            }
        ))),
    wt_action!("wt.ext.remove", vec![vec!["wt", "ext", "remove"]], Some(("DELETE", "/api/wt/ext/:ref")),
        "移除扩展文件登记（磁盘不动）", vec![aarg("ref")], vec![],
        |ctx, _| service::remove_extension(ctx["ref"].as_str().unwrap_or("")),
        Some(|r, _ctx| format!("已移除扩展文件登记: {}（磁盘文件未动）", r["removed"].as_str().unwrap_or("")))),
    ]);
    &ACTIONS
}

type RunFn = fn(&Value, &str) -> Res<Value>;
#[allow(dead_code)]
fn _touch_run(_: RunFn) {}
