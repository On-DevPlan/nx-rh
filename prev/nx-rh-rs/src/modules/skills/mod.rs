// Skill 模块：action 声明是 CLI 命令、HTTP 路由、help 文案的唯一来源。
// 与 modules/skills/index.js + actions.remote.js 对齐。

pub mod adapters;
pub mod entity;
pub mod queries;
pub mod refresh;
pub mod remote;
pub mod remote_parse;
pub mod remote_repo;
pub mod renders;
pub mod scan;
pub mod select;
pub mod service_facade;
pub mod shared;
pub mod sources;
pub mod targets;
pub mod transfer;

use serde_json::{json, Value};

use crate::core::diff::merge3;
use crate::core::errors::{bad_input, Res};
use crate::core::paths::{assert_safe_name, project_root};
use crate::runtime::spec::{Action, ArgSpec, FlagSpec};
use renders::*;

fn project_of(ctx: &Value) -> String {
    ctx.get("project")
        .and_then(|p| p.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| project_root().to_string_lossy().to_string())
}

fn names_of(ctx: &Value) -> Vec<String> {
    match ctx.get("name") {
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(|x| x.as_str())
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty())
            .collect(),
        Some(Value::String(s)) if !s.is_empty() => vec![s.clone()],
        _ => vec![],
    }
}

fn strs_of(ctx: &Value, key: &str) -> Vec<String> {
    match ctx.get(key) {
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(|x| x.as_str())
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty())
            .collect(),
        Some(Value::String(s)) if !s.is_empty() => vec![s.clone()],
        _ => vec![],
    }
}

fn has_selection(ctx: &Value) -> bool {
    let names = names_of(ctx);
    let include = strs_of(ctx, "include");
    !names.is_empty()
        || ctx.get("all").and_then(|a| a.as_bool()).unwrap_or(false)
        || ctx.get("all-sources").and_then(|a| a.as_bool()).unwrap_or(false)
        || !include.is_empty()
}

const SELECT_USAGE: &str = "<name...> | --all | --all-sources | --include <模式>（可叠加 --exclude <模式> / --match <描述关键词>）";

// ---- flag 组 ----

fn to_flag() -> FlagSpec {
    FlagSpec {
        name: "to",
        kind: "string",
        required: false,
        default: Some(json!("project")),
        enum_values: Some(vec!["user", "global", "project", "all"]),
        hint: "",
    }
}

fn select_flags() -> Vec<FlagSpec> {
    vec![
        FlagSpec { name: "all", kind: "boolean", required: false, default: None, enum_values: None, hint: "" },
        FlagSpec { name: "all-sources", kind: "boolean", required: false, default: None, enum_values: None, hint: "铺开全部订阅源（远程订阅仓库通常不是主源）" },
        FlagSpec { name: "include", kind: "array", required: false, default: None, enum_values: None, hint: "模式" },
        FlagSpec { name: "exclude", kind: "array", required: false, default: None, enum_values: None, hint: "模式" },
        FlagSpec { name: "match", kind: "string", required: false, default: None, enum_values: None, hint: "描述关键词" },
        FlagSpec { name: "dry-run", kind: "boolean", required: false, default: None, enum_values: None, hint: "" },
    ]
}

fn project_flag() -> FlagSpec {
    FlagSpec { name: "project", kind: "string", required: false, default: None, enum_values: None, hint: "" }
}

fn sflag(name: &'static str, hint: &'static str) -> FlagSpec {
    FlagSpec { name, kind: "string", required: false, default: None, enum_values: None, hint }
}

fn bflag(name: &'static str) -> FlagSpec {
    FlagSpec { name, kind: "boolean", required: false, default: None, enum_values: None, hint: "" }
}

fn aarg(name: &'static str) -> ArgSpec {
    ArgSpec { name, required: true, rest: false }
}

fn oarg(name: &'static str) -> ArgSpec {
    ArgSpec { name, required: false, rest: false }
}

fn rest_arg(name: &'static str, required: bool) -> ArgSpec {
    ArgSpec { name, required, rest: true }
}

use once_cell::sync::Lazy;

/// action 表（Lazy：Action 里含 Vec 字段，放不进 static 数组）。
pub fn actions() -> &'static Vec<Action> {
    static ACTIONS: Lazy<Vec<Action>> = Lazy::new(|| vec![
    // ══ 远程订阅（actions.remote.js）══
    Action {
        id: "skill.hub.remote.list",
        cli: vec![vec!["skill", "hub", "remote", "list"], vec!["skill", "remote", "list"]],
        http: Some(("GET", "/api/skills/remote")),
        summary: "远程订阅内容：skill 及其来源 / 版本指纹 / 安装状态 / 导入与更新时间",
        args: vec![],
        flags: vec![project_flag()],
        module: "skills",
        run: |ctx, _| remote_repo::remote_contents_with_cells(&project_of(ctx)),
        render: Some(render_remote_hub),
    },
    Action {
        id: "skill.hub.remote.import",
        cli: vec![vec!["skill", "hub", "remote", "import"], vec!["skill", "remote", "import"]],
        http: Some(("POST", "/api/skills/remote/import")),
        summary: "从远程规格导入到远程订阅（owner/repo、git URL、归档 URL；--name 只导一个；--dry-run 只列清单）",
        args: vec![aarg("spec")],
        flags: vec![sflag("name", "只导入这一个 skill"), bflag("dry-run")],
        module: "skills",
        run: |ctx, _| {
            remote_repo::import_to_remote(
                ctx["spec"].as_str().unwrap_or(""),
                ctx["name"].as_str().filter(|s| !s.is_empty()),
                ctx["dry-run"].as_bool().unwrap_or(false),
            )
        },
        render: Some(|d, _ctx| {
            if d["dryRun"].as_bool().unwrap_or(false) {
                let mut lines: Vec<String> = Vec::new();
                let r = d["ref"].as_str().unwrap_or("");
                lines.push(format!(
                    "预演（--dry-run，未拷贝）: {}{} 共 {} 个 skill:",
                    d["spec"].as_str().unwrap_or(""),
                    if r.is_empty() { String::new() } else { format!("@{}", r) },
                    d["count"]
                ));
                for s in d["skills"].as_array().cloned().unwrap_or_default() {
                    lines.push(format!(
                        "  {:<32} {}  {}",
                        s["name"].as_str().unwrap_or(""),
                        s["hash"].as_str().unwrap_or("").chars().take(8).collect::<String>(),
                        s["description"].as_str().unwrap_or("").chars().take(56).collect::<String>()
                    ));
                }
                lines.push(String::new());
                lines.push(format!(
                    "确认导入: nx-rh-rs skill hub remote import {} [--name <skill>]",
                    d["spec"].as_str().unwrap_or("")
                ));
                return lines.join("\n");
            }
            format!(
                "已导入 {} 个到远程订阅: {}\n  落位: {}",
                d["count"],
                d["imported"]
                    .as_array()
                    .map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(", "))
                    .unwrap_or_default(),
                d["dir"].as_str().unwrap_or("")
            )
        }),
    },
    Action {
        id: "skill.hub.remote.add",
        cli: vec![vec!["skill", "hub", "remote", "add"], vec!["skill", "remote", "add"]],
        http: Some(("POST", "/api/skills/remote")),
        summary: "在远程订阅里添加一个手写定义（--description / --content）",
        args: vec![aarg("name")],
        flags: vec![sflag("description", ""), sflag("content", "")],
        module: "skills",
        run: |ctx, _| {
            remote_repo::add_remote_definition(
                ctx["name"].as_str().unwrap_or(""),
                ctx["description"].as_str(),
                ctx["content"].as_str(),
            )
        },
        render: Some(|d, _ctx| {
            format!(
                "已在远程订阅里添加定义: {}\n  落位: {}",
                d["name"].as_str().unwrap_or(""),
                d["dir"].as_str().unwrap_or("")
            )
        }),
    },
    Action {
        id: "skill.hub.remote.link",
        cli: vec![vec!["skill", "hub", "remote", "link"], vec!["skill", "remote", "link"]],
        http: Some(("POST", "/api/skills/remote/link")),
        summary: "在远程订阅里放一个软链（<name> <目标目录>：链到别处已有的 skill，同一份源码多处可用）",
        args: vec![aarg("name"), aarg("target")],
        flags: vec![],
        module: "skills",
        run: |ctx, _| {
            remote_repo::link_into_remote(ctx["name"].as_str().unwrap_or(""), ctx["target"].as_str().unwrap_or(""))
        },
        render: Some(|d, _ctx| {
            format!(
                "已加软链: {} → {}  ({})",
                d["name"].as_str().unwrap_or(""),
                d["target"].as_str().unwrap_or(""),
                d["linkType"].as_str().unwrap_or("")
            )
        }),
    },
    Action {
        id: "skill.hub.remote.link-out",
        cli: vec![vec!["skill", "hub", "remote", "link-out"]],
        http: Some(("POST", "/api/skills/remote/link-out")),
        summary: "把远程订阅里的某份 skill 链到别处（<name> <目标目录>：仓库里这份不动）",
        args: vec![aarg("name"), aarg("target")],
        flags: vec![],
        module: "skills",
        run: |ctx, _| {
            remote_repo::link_from_remote(ctx["name"].as_str().unwrap_or(""), ctx["target"].as_str().unwrap_or(""))
        },
        render: Some(|d, _ctx| {
            format!(
                "已加软链: {} → {}  ({})",
                d["from"].as_str().unwrap_or(""),
                d["to"].as_str().unwrap_or(""),
                d["linkType"].as_str().unwrap_or("")
            )
        }),
    },
    Action {
        id: "skill.hub.remote.update",
        cli: vec![vec!["skill", "hub", "remote", "update"], vec!["skill", "remote", "update"]],
        http: Some(("POST", "/api/skills/remote/update")),
        summary: "按来源重拉更新远程订阅（指纹变了才换；<name...> 只更新指定；--prune 连上游已删的一起清）",
        args: vec![rest_arg("name", false)],
        flags: vec![FlagSpec { name: "prune", kind: "boolean", required: false, default: None, enum_values: None, hint: "上游已删的 skill 同时清掉实体与台账（消僵尸）" }],
        module: "skills",
        run: |ctx, _| {
            remote_repo::update_remote(&names_of(ctx), ctx["prune"].as_bool().unwrap_or(false))
        },
        render: Some(render_remote_update),
    },
    Action {
        id: "skill.hub.remote.remove",
        cli: vec![vec!["skill", "hub", "remote", "remove"], vec!["skill", "remote", "remove"]],
        http: Some(("POST", "/api/skills/remote/remove")),
        summary: "从远程订阅里移除 skill（<name...> 批量；平台侧副本另行 purge）",
        args: vec![rest_arg("name", true)],
        flags: vec![],
        module: "skills",
        run: |ctx, _| remote_repo::remove_from_remote(&names_of(ctx)),
        render: Some(|d, _ctx| {
            format!(
                "已从远程订阅里移除: {}",
                d["removed"]
                    .as_array()
                    .map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(", "))
                    .unwrap_or_else(|| "（无）".into())
            )
        }),
    },

    // ══ 平台适配器 ══
    Action {
        id: "skill.adapters",
        cli: vec![vec!["skill", "hub", "adapters"], vec!["skill", "adapters"]],
        http: Some(("GET", "/api/skills/adapters")),
        summary: "平台适配器清单（每平台的项目级 / 用户级绝对安装位置）",
        args: vec![],
        flags: vec![project_flag()],
        module: "skills",
        run: |ctx, _| Ok(targets::adapters_info(&project_of(ctx))),
        render: Some(render_adapters),
    },

    // ══ 订阅源（Skill Hub）══
    Action {
        id: "skill.sources",
        cli: vec![vec!["skill", "hub", "sources"], vec!["skill", "sources"]],
        http: Some(("GET", "/api/skills/sources")),
        summary: "订阅源清单（* 为当前主源）",
        args: vec![],
        flags: vec![],
        module: "skills",
        run: |_, _| sources::list_sources(),
        render: Some(render_sources),
    },
    Action {
        id: "skill.hub.add",
        cli: vec![vec!["skill", "hub", "subscribe"]],
        http: Some(("POST", "/api/skills/sources")),
        summary: "订阅一个 skill 目录（本地路径）；外部 skill 用 skill hub remote import 导入远程订阅",
        args: vec![aarg("path")],
        flags: vec![],
        module: "skills",
        run: |ctx, _| {
            let path = ctx["path"].as_str().unwrap_or("");
            if remote::peek_remote(path).is_some() {
                return Err(bad_input(format!(
                    "这是远程规格：用 nx-rh-rs skill hub remote import {}（导入远程订阅仓库）",
                    path
                )));
            }
            let d = sources::add_source(path)?;
            let mut out = json!({ "path": path });
            if let Some(obj) = d.as_object() {
                for (k, v) in obj {
                    out[k.as_str()] = v.clone();
                }
            }
            Ok(out)
        },
        render: Some(|d, _ctx| format!("已订阅: {}", d["path"].as_str().unwrap_or(""))),
    },
    Action {
        id: "skill.hub.remove",
        cli: vec![vec!["skill", "hub", "unsubscribe"]],
        http: Some(("DELETE", "/api/skills/sources")),
        summary: "取消订阅（不动磁盘）",
        args: vec![aarg("path")],
        flags: vec![],
        module: "skills",
        run: |ctx, _| sources::remove_source(ctx["path"].as_str().unwrap_or("")),
        render: Some(|d, _ctx| {
            format!(
                "已取消订阅，剩余 {} 个",
                d["sources"].as_array().map(|a| a.len()).unwrap_or(0)
            )
        }),
    },
    Action {
        id: "skill.hub",
        cli: vec![vec!["skill", "hub", "main"], vec!["skill", "hub"]],
        http: None,
        summary: "查看 / 设置当前主订阅源",
        args: vec![oarg("path")],
        flags: vec![],
        module: "skills",
        run: |ctx, _| {
            match ctx["path"].as_str().filter(|s| !s.is_empty()) {
                Some(path) => sources::set_source(path),
                None => {
                    let info = sources::hub_info();
                    let p = info["path"].as_str().unwrap_or("");
                    Ok(if p.is_empty() { json!("（未订阅）") } else { json!(p) })
                }
            }
        },
        render: Some(|d, ctx| {
            if ctx["path"].as_str().map(|s| !s.is_empty()).unwrap_or(false) {
                format!("当前主源: {}", d["current"].as_str().unwrap_or(ctx["path"].as_str().unwrap_or("")))
            } else {
                d.as_str().unwrap_or("").to_string()
            }
        }),
    },
    Action {
        id: "skill.hub.check",
        cli: vec![vec!["skill", "hub", "check"]],
        http: Some(("GET", "/api/skills/hub-check")),
        summary: "订阅源健康检查：目录缺失 / 空源 / 嵌套订阅 / 重复根 / 跨源同名冲突",
        args: vec![],
        flags: vec![],
        module: "skills",
        run: |_, _| queries::source_audit(),
        render: Some(|d, _ctx| {
            if d["ok"].as_bool().unwrap_or(false) {
                return format!(
                    "订阅源健康：{} 个来源，无冲突、无重复",
                    d.pointer("/summary/sources").and_then(|s| s.as_u64()).unwrap_or(0)
                );
            }
            let mut lines: Vec<String> = Vec::new();
            lines.push(format!(
                "订阅源有问题（{} 个来源）:",
                d.pointer("/summary/sources").and_then(|s| s.as_u64()).unwrap_or(0)
            ));
            for p in d["hubProblems"].as_array().cloned().unwrap_or_default() {
                lines.push(format!("  ! {}  —— {}", p["reason"].as_str().unwrap_or(""), p["path"].as_str().unwrap_or("")));
            }
            let conflicts = d["conflicts"].as_array().cloned().unwrap_or_default();
            for c in conflicts.iter().filter(|c| !c["same"].as_bool().unwrap_or(false)) {
                lines.push(format!("  ! 跨源冲突: {}", c["name"].as_str().unwrap_or("")));
                let entries = c["entries"].as_array().cloned().unwrap_or_default();
                let all: Vec<String> = entries
                    .iter()
                    .filter_map(|e| e["source"].as_str().map(|s| s.to_string()))
                    .collect();
                for e in &entries {
                    lines.push(format!(
                        "      {}  {}  {}",
                        shared::source_label(e["source"].as_str().unwrap_or(""), &all),
                        e["md5"].as_str().unwrap_or("").chars().take(8).collect::<String>(),
                        e["dir"].as_str().unwrap_or("")
                    ));
                }
            }
            for c in conflicts.iter().filter(|c| c["same"].as_bool().unwrap_or(false)) {
                lines.push(format!(
                    "  · 重复订阅（内容一致）: {} —— {}",
                    c["name"].as_str().unwrap_or(""),
                    shared::source_labels(&c["entries"])
                ));
            }
            lines.push(String::new());
            lines.push("处理：取消订阅多余来源（skill hub remove）；真冲突保留一份实文件后再迁移。".into());
            lines.join("\n")
        }),
    },
    Action {
        id: "skill.hub.refresh",
        cli: vec![vec!["skill", "hub", "refresh"], vec!["skill", "refresh"]],
        http: Some(("POST", "/api/skills/refresh")),
        summary: "扫描订阅源并与上次快照对比，报告 +新增/-移除/~变更（[source]=路径，缺省全部；首次只建基准）",
        args: vec![oarg("source")],
        flags: vec![],
        module: "skills",
        run: |ctx, _| refresh::refresh_sources(ctx["source"].as_str().unwrap_or(""), false),
        render: Some(render_refresh),
    },

    // ══ 列表 / 详情 / 上下文 ══
    Action {
        id: "skill.list",
        cli: vec![vec!["skill", "hub", "list"], vec!["skill", "scan"]],
        http: Some(("GET", "/api/skills")),
        summary: "列出订阅源 skill（名称 / 来源目录 / 描述 + 各目标迁移状态）",
        args: vec![],
        flags: vec![
            project_flag(),
            sflag("source", ""),
            sflag("platform", ""),
            bflag("long"),
        ],
        module: "skills",
        run: |ctx, _| {
            queries::list_all_skills(
                &project_of(ctx),
                ctx["source"].as_str().unwrap_or(""),
                ctx["platform"].as_str().unwrap_or(""),
            )
        },
        render: Some(render_skill_list),
    },
    Action {
        id: "skill.show",
        cli: vec![vec!["skill", "hub", "show"], vec!["skill", "show"], vec!["skill", "describe"]],
        http: Some(("GET", "/api/skills/detail")),
        summary: "查看单个 skill：完整描述 + 来源目录 + 各平台安装状态与当前形态",
        args: vec![aarg("name")],
        flags: vec![project_flag()],
        module: "skills",
        run: |ctx, _| queries::skill_info(ctx["name"].as_str().unwrap_or(""), &project_of(ctx)),
        render: Some(render_show),
    },
    Action {
        id: "skill.cat",
        cli: vec![vec!["skill", "hub", "cat"], vec!["skill", "cat"]],
        http: Some(("GET", "/api/skills/content")),
        summary: "输出 skill 全文（SKILL.md 或 --ref <相对路径>），订阅源与不在订阅源的平台副本都能读",
        args: vec![aarg("name")],
        flags: vec![sflag("ref", "skill 内相对路径，如 references/api.md"), project_flag()],
        module: "skills",
        run: |ctx, _| {
            queries::skill_content(
                ctx["name"].as_str().unwrap_or(""),
                ctx["ref"].as_str().unwrap_or(""),
                &project_of(ctx),
            )
        },
        render: Some(|d, _ctx| {
            let bar = "─".repeat(60);
            let source = d["source"].as_str().unwrap_or("");
            let r#where = if !source.is_empty() {
                format!("来源: {}", source)
            } else {
                format!("目录: {}", d["dir"].as_str().unwrap_or(""))
            };
            let spec = d.pointer("/upstream/spec").and_then(|s| s.as_str()).unwrap_or("");
            let remote_hint = if !spec.is_empty() {
                let r = d.pointer("/upstream/ref").and_then(|s| s.as_str()).unwrap_or("");
                format!(
                    "# 外部 skill，上游 {}{}；跟进更新: nx-rh-rs skill hub remote update {}",
                    spec,
                    if r.is_empty() { String::new() } else { format!("@{}", r) },
                    d["skillName"].as_str().unwrap_or("")
                )
            } else {
                String::new()
            };
            [
                format!("# skill: {}   {}", d["skillName"].as_str().unwrap_or(""), r#where),
                bar.clone(),
                d["content"].as_str().unwrap_or("").trim_end().to_string(),
                bar,
                remote_hint,
                format!("# 需要安装到本机？nx-rh-rs skill hub migrate {} --to user", d["skillName"].as_str().unwrap_or("")),
            ]
            .iter()
            .filter(|s| !s.is_empty())
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
        }),
    },

    // ══ skill 实体的增改删 ══
    Action {
        id: "skill.add",
        cli: vec![vec!["skill", "hub", "add"], vec!["skill", "add"]],
        http: Some(("POST", "/api/skills")),
        summary: "在订阅源新建一个 skill（已存在同名则报冲突）",
        args: vec![aarg("name")],
        flags: vec![sflag("description", ""), sflag("content", "")],
        module: "skills",
        run: |ctx, _| {
            entity::add_skill(
                ctx["name"].as_str().unwrap_or(""),
                ctx["description"].as_str().unwrap_or(""),
                ctx["content"].as_str().unwrap_or(""),
            )
        },
        render: Some(|d, _ctx| format!("已创建: {}", d["path"].as_str().unwrap_or(""))),
    },
    Action {
        id: "skill.update",
        cli: vec![vec!["skill", "hub", "update"], vec!["skill", "update"]],
        http: Some(("PATCH", "/api/skills/:name")),
        summary: "改写订阅源 skill 的 SKILL.md 全文（须含 name/description frontmatter）",
        args: vec![aarg("name")],
        flags: vec![FlagSpec { name: "content", kind: "string", required: true, default: None, enum_values: None, hint: "" }],
        module: "skills",
        run: |ctx, _| entity::update_skill(ctx["name"].as_str().unwrap_or(""), ctx["content"].as_str().unwrap_or("")),
        render: Some(|d, _ctx| format!("已保存: {}\\SKILL.md", d["dir"].as_str().unwrap_or(""))),
    },
    Action {
        id: "skill.remove",
        cli: vec![vec!["skill", "hub", "remove"], vec!["skill", "remove"]],
        http: Some(("DELETE", "/api/skills/:name")),
        summary: "从订阅源删除 skill（目标侧还有引用时返回 blocked，--force 继续）",
        args: vec![aarg("name")],
        flags: vec![bflag("force"), project_flag()],
        module: "skills",
        run: |ctx, _| {
            entity::remove_skill(
                ctx["name"].as_str().unwrap_or(""),
                ctx["force"].as_bool().unwrap_or(false),
                &project_of(ctx),
            )
        },
        render: Some(|d, _ctx| {
            if d["status"].as_str() == Some("blocked") {
                let refs: Vec<String> = d["refs"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .iter()
                    .map(|x| {
                        format!(
                            "  {}·{} {}",
                            shared::scope_mark(x["scope"].as_str().unwrap_or("")),
                            x["platform"].as_str().unwrap_or(""),
                            x["path"].as_str().unwrap_or("")
                        )
                    })
                    .collect();
                return format!(
                    "已阻止: {}\n{}\n确认 dangling 再加 --force",
                    d["reason"].as_str().unwrap_or(""),
                    refs.join("\n")
                );
            }
            let dangling = d["dangling"].as_array().map(|a| a.len()).unwrap_or(0);
            format!(
                "已删除: {}{}",
                d["removed"].as_str().unwrap_or(""),
                if dangling > 0 {
                    format!("（{} 个目标现为悬空，可用迁移重建）", dangling)
                } else {
                    String::new()
                }
            )
        }),
    },
    Action {
        id: "skill.purge",
        cli: vec![vec!["skill", "hub", "purge"], vec!["skill", "purge"]],
        http: Some(("POST", "/api/skills/purge")),
        summary: "彻底删除 skill：所有平台安装位置 + 订阅源里的实文件（<name...> 可批量；--dry-run 先看清单）",
        args: vec![rest_arg("name", true)],
        flags: vec![
            FlagSpec { name: "force", kind: "boolean", required: false, default: None, enum_values: None, hint: "安装位置里有实体副本时必须加（可能含本地改动）" },
            project_flag(),
            bflag("dry-run"),
        ],
        module: "skills",
        run: |ctx, _| {
            let names = names_of(ctx);
            let force = ctx["force"].as_bool().unwrap_or(false);
            let dry = ctx["dry-run"].as_bool().unwrap_or(false);
            let project = project_of(ctx);
            if names.len() == 1 {
                entity::purge_skill(&names[0], &project, force, dry)
            } else if names.is_empty() {
                Err(bad_input("用法: nx-rh-rs skill hub purge <name...> —— 至少给一个 skill 名"))
            } else {
                entity::purge_skills(&names, &project, force, dry)
            }
        },
        render: Some(render_purge),
    },
    Action {
        id: "skill.hub.search",
        cli: vec![vec!["skill", "hub", "search"], vec!["skill", "search"]],
        http: Some(("GET", "/api/skills/search")),
        summary: "搜 skills.sh 注册表（[--owner <o>] 限定组织/用户；结果含来源与安装量，可直接 subscribe）",
        args: vec![rest_arg("query", false)],
        flags: vec![sflag("owner", "GitHub 组织/用户名"), sflag("limit", "最多返回条数（默认 20）")],
        module: "skills",
        run: |ctx, _| {
            let words: Vec<String> = match ctx.get("query") {
                Some(Value::Array(arr)) => arr
                    .iter()
                    .filter_map(|x| x.as_str())
                    .map(|s| s.to_string())
                    .collect(),
                Some(Value::String(s)) if !s.is_empty() => vec![s.clone()],
                _ => vec![],
            };
            refresh::search_registry(
                &words.join(" "),
                ctx["owner"].as_str().unwrap_or(""),
                ctx["limit"].as_str().unwrap_or(""),
            )
        },
        render: Some(render_search),
    },
    Action {
        id: "skill.hub.dedupe",
        cli: vec![vec!["skill", "hub", "dedupe"]],
        http: Some(("POST", "/api/skills/dedupe")),
        summary: "跨源重复/冲突唯一化：--source 指定以哪份实文件为准，其余 --as link（转链接）| delete（删除）",
        args: vec![aarg("name")],
        flags: vec![
            FlagSpec { name: "source", kind: "string", required: true, default: None, enum_values: None, hint: "以哪个订阅源里的实文件为准（订阅源路径）" },
            FlagSpec { name: "as", kind: "string", required: false, default: Some(json!("link")), enum_values: Some(vec!["link", "delete"]), hint: "" },
            FlagSpec { name: "force", kind: "boolean", required: false, default: None, enum_values: None, hint: "非准份也是实文件（可能含本地改动），丢弃不可逆，须显式确认" },
            bflag("dry-run"),
        ],
        module: "skills",
        run: |ctx, _| {
            entity::dedupe_skill(
                ctx["name"].as_str().unwrap_or(""),
                ctx["source"].as_str().unwrap_or(""),
                ctx["as"].as_str().unwrap_or("link"),
                ctx["force"].as_bool().unwrap_or(false),
                ctx["dry-run"].as_bool().unwrap_or(false),
            )
        },
        render: Some(render_dedupe),
    },
    Action {
        id: "skill.hub.dedupe-all",
        cli: vec![vec!["skill", "hub", "dedupe-all"]],
        http: Some(("POST", "/api/skills/dedupe-all")),
        summary: "批量唯一化：重复/冲突组都以主源实文件为准，其余 --as link（转链接）| delete（删除）",
        args: vec![],
        flags: vec![
            sflag("names", "只处理这些 skill（逗号分隔）；缺省=全部重复/冲突组"),
            FlagSpec { name: "as", kind: "string", required: false, default: Some(json!("link")), enum_values: Some(vec!["link", "delete"]), hint: "" },
            FlagSpec { name: "force", kind: "boolean", required: false, default: None, enum_values: None, hint: "非准份也是实文件（可能含本地改动），丢弃不可逆，须显式确认" },
            bflag("dry-run"),
        ],
        module: "skills",
        run: |ctx, _| {
            let names: Vec<String> = match ctx.get("names") {
                Some(Value::Array(arr)) => arr
                    .iter()
                    .filter_map(|x| x.as_str())
                    .map(|s| s.to_string())
                    .collect(),
                Some(Value::String(s)) if !s.is_empty() => {
                    s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect()
                }
                _ => vec![],
            };
            entity::dedupe_all(
                &names,
                ctx["as"].as_str().unwrap_or("link"),
                ctx["force"].as_bool().unwrap_or(false),
                ctx["dry-run"].as_bool().unwrap_or(false),
            )
        },
        render: Some(render_dedupe_all),
    },

    // ══ 迁移 / 撤销 / 提交 / 物化 ══
    Action {
        id: "skill.migrate",
        cli: vec![vec!["skill", "hub", "migrate"], vec!["skill", "migrate"], vec!["skill", "adapt"]],
        http: Some(("POST", "/api/skills/migrate")),
        summary: "订阅源 → 平台目录（<name...> | --all | --include；--exclude/--match 精筛；--dry-run 预演）",
        args: vec![rest_arg("name", false)],
        flags: {
            let mut v = vec![
                to_flag(),
                sflag("platform", ""),
                FlagSpec { name: "mode", kind: "string", required: false, default: None, enum_values: Some(vec!["symlink", "copy"]), hint: "" },
                project_flag(),
                sflag("source", ""),
            ];
            v.extend(select_flags());
            v
        },
        module: "skills",
        run: |ctx, _| {
            if !has_selection(ctx) {
                return Err(bad_input(format!(
                    "用法: nx-rh-rs skill hub migrate {}",
                    SELECT_USAGE
                )));
            }
            transfer::migrate_skill(&transfer::MigrateInput {
                names: &leak_names(ctx),
                all: ctx["all"].as_bool().unwrap_or(false),
                all_sources: ctx["all-sources"].as_bool().unwrap_or(false),
                include: &leak_strs(ctx, "include"),
                exclude: &leak_strs(ctx, "exclude"),
                match_desc: ctx["match"].as_str().unwrap_or(""),
                to: ctx["to"].as_str().unwrap_or("project"),
                platform: ctx["platform"].as_str().unwrap_or(""),
                mode: ctx["mode"].as_str().unwrap_or(""),
                project: &project_of(ctx),
                source: ctx["source"].as_str().unwrap_or(""),
                dry_run: ctx["dry-run"].as_bool().unwrap_or(false),
                force: false,
            })
        },
        render: Some(render_migrate),
    },
    Action {
        id: "skill.unmigrate",
        cli: vec![vec!["skill", "hub", "unmigrate"], vec!["skill", "unmigrate"]],
        http: Some(("POST", "/api/skills/unmigrate")),
        summary: "撤销迁移（<name...> | --all | --include；--exclude/--match 精筛；--dry-run 预演）",
        args: vec![rest_arg("name", false)],
        flags: {
            let mut v = vec![to_flag(), sflag("platform", ""), project_flag(), bflag("force")];
            v.extend(select_flags());
            v
        },
        module: "skills",
        run: |ctx, _| {
            if !has_selection(ctx) {
                return Err(bad_input(format!(
                    "用法: nx-rh-rs skill hub unmigrate {}",
                    SELECT_USAGE
                )));
            }
            transfer::unmigrate_skill(&transfer::MigrateInput {
                names: &leak_names(ctx),
                all: ctx["all"].as_bool().unwrap_or(false),
                all_sources: ctx["all-sources"].as_bool().unwrap_or(false),
                include: &leak_strs(ctx, "include"),
                exclude: &leak_strs(ctx, "exclude"),
                match_desc: ctx["match"].as_str().unwrap_or(""),
                to: ctx["to"].as_str().unwrap_or("project"),
                platform: ctx["platform"].as_str().unwrap_or(""),
                mode: "",
                project: &project_of(ctx),
                source: "",
                dry_run: ctx["dry-run"].as_bool().unwrap_or(false),
                force: ctx["force"].as_bool().unwrap_or(false),
            })
        },
        render: Some(render_unmigrate),
    },
    Action {
        id: "skill.submit",
        cli: vec![vec!["skill", "hub", "submit"], vec!["skill", "submit"]],
        http: Some(("POST", "/api/skills/submit")),
        summary: "平台副本 → 订阅源（<name...> | --all 取「不在订阅源」那批；提交后删除目标实文件）",
        args: vec![rest_arg("name", false)],
        flags: {
            let mut v = vec![
                FlagSpec { name: "to", kind: "string", required: false, default: Some(json!("all")), enum_values: Some(vec!["user", "global", "project", "all"]), hint: "" },
                sflag("platform", ""),
                project_flag(),
                bflag("force"),
                bflag("keepTarget"),
                sflag("into", "收进哪个订阅源（须已订阅；缺省当前主源）"),
            ];
            v.extend(select_flags());
            v
        },
        module: "skills",
        run: |ctx, _| {
            if !has_selection(ctx) {
                return Err(bad_input(format!(
                    "用法: nx-rh-rs skill hub submit {}",
                    SELECT_USAGE
                )));
            }
            transfer::submit_skill(&transfer::SubmitInput {
                names: &leak_names(ctx),
                all: ctx["all"].as_bool().unwrap_or(false),
                include: &leak_strs(ctx, "include"),
                exclude: &leak_strs(ctx, "exclude"),
                match_desc: ctx["match"].as_str().unwrap_or(""),
                to: ctx["to"].as_str().unwrap_or("all"),
                platform: ctx["platform"].as_str().unwrap_or(""),
                project: &project_of(ctx),
                force: ctx["force"].as_bool().unwrap_or(false),
                keep_target: ctx["keepTarget"].as_bool().unwrap_or(false),
                dry_run: ctx["dry-run"].as_bool().unwrap_or(false),
                into: ctx["into"].as_str().unwrap_or(""),
            })
        },
        render: Some(render_submit),
    },
    Action {
        id: "skill.materialize",
        cli: vec![vec!["skill", "hub", "materialize"], vec!["skill", "materialize"]],
        http: Some(("POST", "/api/skills/materialize")),
        summary: "把目标侧的链接转换为实体副本",
        args: vec![aarg("name")],
        flags: vec![to_flag(), sflag("platform", ""), project_flag()],
        module: "skills",
        run: |ctx, _| {
            transfer::materialize_skill(
                ctx["name"].as_str().unwrap_or(""),
                ctx["to"].as_str().unwrap_or("project"),
                ctx["platform"].as_str().unwrap_or(""),
                &project_of(ctx),
            )
        },
        render: Some(|d, _ctx| {
            if d["converted"].as_bool().unwrap_or(false) {
                let results: Vec<String> = d["results"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .iter()
                    .map(|r| format!("{}·{}", r["scope"].as_str().unwrap_or(""), r["platform"].as_str().unwrap_or("")))
                    .collect();
                format!("已转换为实体: {}", results.join(", "))
            } else {
                "（目标侧本就没有链接）".into()
            }
        }),
    },

    // ══ 设置：平台范围 / 项目目录 ══
    Action {
        id: "setting.platforms",
        cli: vec![vec!["skill", "hub", "platform"], vec!["skill", "platform"]],
        http: None,
        summary: "查看 / 设置启用的平台（首个为默认平台）",
        args: vec![rest_arg("platforms", false)],
        flags: vec![],
        module: "skills",
        run: |ctx, _| {
            let platforms: Vec<String> = match ctx.get("platforms") {
                Some(Value::Array(arr)) => arr
                    .iter()
                    .filter_map(|x| x.as_str())
                    .map(|s| s.to_string())
                    .collect(),
                _ => vec![],
            };
            if !platforms.is_empty() {
                return super::settings::service::update_settings(&json!({
                    "platforms": platforms,
                    "defaultPlatform": platforms[0]
                }));
            }
            let s = super::settings::service::get_settings();
            Ok(json!({
                "platforms": s["platforms"],
                "defaultPlatform": s["defaultPlatform"]
            }))
        },
        render: Some(|d, _ctx| {
            format!(
                "平台: {}\n默认: {}",
                d["platforms"]
                    .as_array()
                    .map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(", "))
                    .unwrap_or_default(),
                d["defaultPlatform"].as_str().unwrap_or("")
            )
        }),
    },
    Action {
        id: "skill.project.list",
        cli: vec![vec!["skill", "hub", "project", "list"], vec!["skill", "project", "list"], vec!["skill", "project"]],
        http: None,
        summary: "项目目录候选清单",
        args: vec![],
        flags: vec![],
        module: "skills",
        run: |_, _| super::settings::service::list_candidates("project"),
        render: Some(|l, _ctx| {
            let arr = l.as_array().cloned().unwrap_or_default();
            if arr.is_empty() {
                return "（暂无项目目录候选，用 skill hub project add <path> 添加）".into();
            }
            arr.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join("\n")
        }),
    },
    Action {
        id: "skill.project.skills",
        cli: vec![vec!["skill", "hub", "project", "skills"], vec!["skill", "project", "skills"]],
        http: Some(("GET", "/api/skills/project-skills")),
        summary: "当前项目目录里的 skill（扫全部适配器项目级目录，标注是否已在订阅源）",
        args: vec![],
        flags: vec![project_flag()],
        module: "skills",
        run: |ctx, _| queries::list_project_skills(&project_of(ctx)),
        render: Some(render_project_list),
    },
    Action {
        id: "skill.project.add",
        cli: vec![vec!["skill", "hub", "project", "add"], vec!["skill", "project", "add"]],
        http: Some(("POST", "/api/skills/project")),
        summary: "添加项目目录候选",
        args: vec![aarg("path")],
        flags: vec![],
        module: "skills",
        run: |ctx, _| {
            super::settings::service::add_candidate("project", ctx["path"].as_str().unwrap_or(""))
        },
        render: Some(|l, ctx| {
            let arr = l.as_array().cloned().unwrap_or_default();
            let last = arr
                .last()
                .and_then(|x| x.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| ctx["path"].as_str().unwrap_or("").to_string());
            format!("已添加项目目录（共 {} 个）: {}", arr.len(), last)
        }),
    },
    Action {
        id: "skill.project.remove",
        cli: vec![vec!["skill", "hub", "project", "remove"], vec!["skill", "project", "remove"]],
        http: Some(("DELETE", "/api/skills/project")),
        summary: "从候选移除项目目录（不动磁盘）",
        args: vec![aarg("path")],
        flags: vec![],
        module: "skills",
        run: |ctx, _| {
            super::settings::service::remove_candidate("project", ctx["path"].as_str().unwrap_or(""))
        },
        render: Some(|l, _ctx| {
            format!(
                "已移除，剩余 {} 个",
                l.as_array().map(|a| a.len()).unwrap_or(0)
            )
        }),
    },

    // ══ 通用：三方合并 ══
    Action {
        id: "skill.merge",
        cli: vec![vec!["skill", "hub", "merge"], vec!["skill", "merge"]],
        http: Some(("POST", "/api/util/merge")),
        summary: "diff3-lite 三方合并原语（CLI 传文件路径，HTTP 传文本）",
        args: vec![],
        flags: vec![
            FlagSpec { name: "base", kind: "string", required: true, default: None, enum_values: None, hint: "" },
            FlagSpec { name: "a", kind: "string", required: true, default: None, enum_values: None, hint: "" },
            FlagSpec { name: "b", kind: "string", required: true, default: None, enum_values: None, hint: "" },
            sflag("labelA", ""),
            sflag("labelB", ""),
        ],
        module: "skills",
        run: |ctx, transport| {
            if transport == "http" {
                let r = merge3(
                    ctx["base"].as_str().unwrap_or(""),
                    ctx["a"].as_str().unwrap_or(""),
                    ctx["b"].as_str().unwrap_or(""),
                    ctx["labelA"].as_str().unwrap_or("ours"),
                    ctx["labelB"].as_str().unwrap_or("theirs"),
                );
                return Ok(serde_json::to_value(&r).unwrap_or(json!({})));
            }
            let read = |p: &str| -> Res<String> {
                std::fs::read_to_string(p).map_err(|e| bad_input(format!("无法读取 {}: {}", p, e)))
            };
            let base = read(ctx["base"].as_str().unwrap_or(""))?;
            let a = read(ctx["a"].as_str().unwrap_or(""))?;
            let b = read(ctx["b"].as_str().unwrap_or(""))?;
            let r = merge3(&base, &a, &b, "ours", "theirs");
            Ok(serde_json::to_value(&r).unwrap_or(json!({})))
        },
        render: Some(|d, _ctx| d["merged"].as_str().unwrap_or("").to_string()),
    },
    ]);
    &ACTIONS
}

// 生命周期辅助：MigrateInput 需要 &'a [String]——把 ctx 派生的向量泄漏成 'static。
// 这些向量每条命令只构造一次、进程随即退出，泄漏量可忽略。
fn leak_names(ctx: &Value) -> &'static [String] {
    Box::leak(names_of(ctx).into_boxed_slice())
}

fn leak_strs(ctx: &Value, key: &str) -> &'static [String] {
    Box::leak(strs_of(ctx, key).into_boxed_slice())
}

// assert_safe_name 引用防未用（skill.add 内部路径使用）
#[allow(dead_code)]
fn _touch() {
    let _ = assert_safe_name("x", "y");
}

// service_facade 由 mod.rs 引出（hub_info / list_sources 给 system bootstrap 用）
pub use service_facade::service;
