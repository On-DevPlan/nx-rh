// 对齐断言：Rust 版与 JS 版必须保持同一套契约。
//
// 这些断言对应脚手架规范里的「一致性断言」职责——
// action 表、路由表、用法串、错误契约，任何一边改了另一边没跟上，这里就红。

use serde_json::Value;

use crate::core::errors::{bad_input, http_status_of, to_error_payload, AppError, BLOCKED, CONFLICT, EXTERNAL, INVALID_INPUT, NOT_FOUND};
use crate::core::frontmatter::parse_frontmatter;
use crate::core::gitignore::parse_gitignore;
use crate::core::mdoutline::md_outline;
use crate::core::paths::assert_safe_name;
use crate::runtime::registry;
use crate::runtime::spec::{apply_spec, cli_paths_of, compile_route, usage_of, RouteSeg};

// ─── action 表 ───────────────────────────────────────────────────────

#[test]
fn action_ids_unique() {
    let mut ids = std::collections::HashSet::new();
    for a in registry::actions() {
        assert!(ids.insert(a.id), "action id 重复: {}", a.id);
    }
}

#[test]
fn cli_paths_unique() {
    let mut seen = std::collections::HashSet::new();
    for a in registry::actions() {
        for p in cli_paths_of(a) {
            let key = p.join(" ");
            assert!(seen.insert(key.clone()), "CLI 命令重复: {}（{}）", key, a.id);
        }
    }
}

#[test]
fn http_routes_unique() {
    let mut seen = std::collections::HashSet::new();
    for a in registry::actions() {
        if let Some((m, p)) = a.http {
            let key = format!("{} {}", m, p);
            assert!(seen.insert(key.clone()), "HTTP 路由重复: {}（{}）", key, a.id);
        }
    }
}

/// 每条 action 都必须有 CLI 路径 —— 「Web 上能做的，CLI 都必须能做」是结构性保证。
#[test]
fn every_action_has_cli() {
    for a in registry::actions() {
        assert!(!cli_paths_of(a).is_empty(), "action 没有声明 CLI 命令: {}", a.id);
    }
}

/// 平台命令与 action 表一起构成完整命令面。
#[test]
fn builtin_commands_present() {
    let entries = registry::builtin_command_entries();
    let ids: Vec<&str> = entries.iter().map(|e| e.id.as_str()).collect();
    for want in ["serve", "help", "version"] {
        assert!(ids.contains(&want), "缺平台命令: {}", want);
    }
}

/// 用法串必须从声明反推得出，且包含命令路径与必填参数。
#[test]
fn usage_includes_path_and_required_args() {
    for a in registry::actions() {
        let u = usage_of(a);
        assert!(u.starts_with("nx-rh-rs "), "用法串缺命令前缀: {}", u);
        let path = cli_paths_of(a).first().cloned().unwrap_or_default();
        assert!(u.contains(&path.join(" ")), "用法串不含命令路径: {}", u);
    }
}

// ─── HTTP 路由匹配 ───────────────────────────────────────────────────

#[test]
fn route_matches_literal_and_param() {
    let r = compile_route("/api/env/:name");
    let segs: Vec<&str> = "api/env/TEMP".split('/').collect();
    let params = r.match_path(&segs);
    assert!(params.is_some(), "参数路由没匹配上");
    assert_eq!(params.unwrap()[0].1, "TEMP");
}

#[test]
fn route_rejects_wrong_segment_count() {
    let r = compile_route("/api/env/:name");
    let segs: Vec<&str> = "api/env/TEMP/extra".split('/').collect();
    assert!(r.match_path(&segs).is_none(), "段数不该匹配");
}

#[test]
fn route_literal_is_not_param() {
    let r = compile_route("/api/env/:name");
    assert!(matches!(r.segments[2], RouteSeg::Param(_)));
    let r2 = compile_route("/api/env/path");
    assert!(matches!(r2.segments[2], RouteSeg::Literal(_)));
}

// ─── 参数校验（ctx 契约）─────────────────────────────────────────────

fn find_action(id: &str) -> &'static crate::runtime::spec::Action {
    registry::actions().iter().copied().find(|a| a.id == id).expect("找不到 action")
}

#[test]
fn required_flag_missing_gives_usage_prefix() {
    let a = find_action("skill.hub.dedupe");
    let e = apply_spec(a, &serde_json::json!({})).unwrap_err();
    assert_eq!(e.code, INVALID_INPUT);
    assert!(
        e.message.starts_with("用法: "),
        "缺参数错误必须带「用法:」前缀（agent 靠它分类）: {}",
        e.message
    );
}

#[test]
fn boolean_flag_does_not_eat_next_token() {
    // --force 是布尔：apply_spec 后仍是布尔，不会被当成字符串
    let a = find_action("skill.remove");
    let ctx = apply_spec(a, &serde_json::json!({ "name": "x", "force": true })).unwrap();
    assert_eq!(ctx["force"], Value::Bool(true));
}

#[test]
fn enum_flag_rejects_other_value() {
    let a = find_action("skill.hub.dedupe");
    let e = apply_spec(
        a,
        &serde_json::json!({ "name": "x", "source": "s", "as": "bogus" }),
    )
    .unwrap_err();
    assert_eq!(e.code, INVALID_INPUT);
    assert!(e.message.contains("只能是"), "枚举报错文案不对: {}", e.message);
}

#[test]
fn number_flag_rejects_non_number() {
    let a = find_action("wt.context");
    let e = apply_spec(a, &serde_json::json!({ "log": "abc" })).unwrap_err();
    assert_eq!(e.code, INVALID_INPUT);
}

// ─── 错误契约 ────────────────────────────────────────────────────────

#[test]
fn error_codes_map_to_http_status() {
    assert_eq!(http_status_of(INVALID_INPUT), 400);
    assert_eq!(http_status_of(NOT_FOUND), 404);
    assert_eq!(http_status_of(CONFLICT), 409);
    assert_eq!(http_status_of(BLOCKED), 409);
    assert_eq!(http_status_of(EXTERNAL), 502);
}

#[test]
fn error_payload_keeps_anchor_words() {
    // 「用法:」「未设置」「不存在」是 agent 失败分类的锚点，不得删除
    let e = bad_input("用法: nx-rh-rs x —— 缺少参数");
    let p = to_error_payload(&e);
    assert_eq!(p.code, INVALID_INPUT);
    assert!(p.message.contains("用法:"));
}

// ─── 安全名校验 ──────────────────────────────────────────────────────

#[test]
fn safe_name_rejects_traversal_and_hidden() {
    assert!(assert_safe_name("../evil", "skill 名称").is_err());
    assert!(assert_safe_name("a/b", "skill 名称").is_err());
    assert!(assert_safe_name(".hidden", "skill 名称").is_err());
    assert!(assert_safe_name("", "skill 名称").is_err());
    assert!(assert_safe_name("ok-name", "skill 名称").is_ok());
    assert!(assert_safe_name("中文名", "skill 名称").is_ok());
}

// ─── frontmatter ─────────────────────────────────────────────────────

#[test]
fn frontmatter_parses_crlf() {
    let fm = parse_frontmatter("---\r\nname: demo\r\ndescription: 说明\r\n---\r\nbody");
    assert_eq!(fm.name, "demo");
    assert_eq!(fm.description, "说明");
}

#[test]
fn frontmatter_handles_block_scalar() {
    let fm = parse_frontmatter("---\nname: demo\ndescription: |\n  line1\n  line2\n---\n");
    assert_eq!(fm.description, "line1\nline2");
}

#[test]
fn frontmatter_missing_returns_empty() {
    let fm = parse_frontmatter("no frontmatter here");
    assert_eq!(fm.name, "");
    assert_eq!(fm.description, "");
}

// ─── gitignore 解析 ──────────────────────────────────────────────────

#[test]
fn gitignore_parses_entries() {
    let entries = parse_gitignore("# comment\n!keep.txt\nnode_modules/\n/build\n*.log\n");
    assert_eq!(entries.len(), 4);
    assert!(entries[0].negated);
    assert!(entries[1].dir_only);
    assert_eq!(entries[1].path, "node_modules");
    assert!(entries[2].root_anchored);
    assert!(entries[3].has_glob);
}

// ─── markdown outline ────────────────────────────────────────────────

#[test]
fn outline_skips_code_fences() {
    let md = "# A\n```\n# not a heading\n```\n## B\n";
    let o = md_outline(md, 3);
    assert_eq!(o.len(), 2);
    assert_eq!(o[0].text, "A");
    assert_eq!(o[1].text, "B");
}

// ─── AppError 结构 ───────────────────────────────────────────────────

#[test]
fn app_error_carries_details() {
    let mut e = AppError { code: CONFLICT.into(), message: "冲突".into(), details: None };
    e.details = Some(serde_json::json!({ "a": 1 }));
    let p = to_error_payload(&e);
    assert_eq!(p.code, CONFLICT);
    assert!(p.details.is_some());
}
