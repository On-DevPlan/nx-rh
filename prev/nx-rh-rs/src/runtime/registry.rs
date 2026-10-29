// 模块注册表：所有功能域的 action 在此汇合 —— 与 runtime/registry.js 对齐。
// CLI 命令表、HTTP 路由表、help 文本三者全部由此派生。
//
// 装载期自检：id 重复 / CLI 路径重复 / HTTP 路由重复 / 缺 run，在启动瞬间炸，
// 而不是等用户敲到那条命令时才发现。

use once_cell::sync::Lazy;

use super::spec::Action;

pub mod modules_decl {
    // 各模块的 action 表（见 src/modules/*/mod.rs）
    pub fn all_actions() -> Vec<&'static crate::runtime::spec::Action> {
        let mut v = Vec::new();
        v.extend(crate::modules::system::actions().iter());
        v.extend(crate::modules::worktrees::actions().iter());
        v.extend(crate::modules::skills::actions().iter());
        v.extend(crate::modules::settings::actions().iter());
        v.extend(crate::modules::env::actions().iter());
        v.extend(crate::modules::bundled::actions().iter());
        v
    }
}

/// 平台命令（serve/help/version）用与 action 相同的形状声明。
/// run 用动态分发（serve 需要特殊处理），见 cli.rs 的 BUILTINS 处理。
pub struct Builtin {
    pub id: &'static str,
    pub cli: Vec<Vec<&'static str>>,
    pub summary: &'static str,
    /// usage 串：平台命令的 flag 不走 FlagSpec（serve 的 --port 有默认值但不进 action 表），
    /// 所以这里显式写一份，且与 JS 的 usageOf 输出逐字一致（由单测钉住）。
    pub usage: &'static str,
}

pub fn builtins() -> Vec<Builtin> {
    vec![
        Builtin {
            id: "serve",
            cli: vec![vec!["serve"]],
            summary: "启动 Web 面板（默认 :7801；可跟项目目录；--port N 改端口；--no-open 不开浏览器；端口上已有本面板则直接打开它，否则顺延到下一个空闲端口；NX_SERVE_NO_OPEN=1 全局不开浏览器）",
            usage: "nx-rh-rs serve [dir] [--port <port>] [--no-open]",
        },
        Builtin {
            id: "help",
            cli: vec![vec!["help"]],
            summary: "显示帮助（可跟模块名或命令组，如 nx-rh-rs help repo）",
            usage: "nx-rh-rs help [topic]",
        },
        Builtin {
            id: "version",
            cli: vec![vec!["version"]],
            summary: "显示版本",
            usage: "nx-rh-rs version",
        },
    ]
}

pub fn actions() -> &'static Vec<&'static Action> {
    static ACTIONS: Lazy<Vec<&'static Action>> = Lazy::new(|| {
        let v = modules_decl::all_actions();
        // 装载期自检
        let mut seen_ids = std::collections::HashSet::new();
        let mut seen_cli = std::collections::HashSet::new();
        let mut seen_http = std::collections::HashSet::new();
        for a in &v {
            if !seen_ids.insert(a.id) {
                panic!("action id 重复: {}", a.id);
            }
            let paths = super::spec::cli_paths_of(a);
            if paths.is_empty() {
                panic!("action 没有声明 CLI 命令（Web 操作必须有 CLI 等价）: {}", a.id);
            }
            for p in paths {
                let key = p.join(" ");
                if !seen_cli.insert(key.clone()) {
                    panic!("CLI 命令重复: {}（action {}）", key, a.id);
                }
            }
            if let Some((m, path)) = a.http {
                let key = format!("{} {}", m, path);
                if !seen_http.insert(key.clone()) {
                    panic!("HTTP 路由重复: {}（action {}）", key, a.id);
                }
            }
        }
        v
    });
    &ACTIONS
}

/// 全部命令（含平台命令的形状包装），供 help 与 routes 输出。
#[derive(Debug, Clone)]
pub struct CommandEntry {
    pub id: String,
    pub module: String,
    pub command: String,
    pub usage: String,
    pub http: Option<(String, String)>,
    pub summary: String,
}

pub fn command_entry_of_action(a: &Action) -> CommandEntry {
    CommandEntry {
        id: a.id.to_string(),
        module: a.module.to_string(),
        command: format!("nx-rh-rs {}", a.cli.first().cloned().unwrap_or_default().join(" ")),
        usage: super::spec::usage_of(a),
        http: a.http.map(|(m, p)| (m.to_string(), p.to_string())),
        summary: a.summary.to_string(),
    }
}

pub fn builtin_command_entries() -> Vec<CommandEntry> {
    // 从 builtins() 派生，不再手抄一遍命令名与 usage ——
    // 手抄的那份曾经把 `--port <port>` 写成 `--port <number>`，与 JS 分叉。
    builtins()
        .into_iter()
        .map(|b| CommandEntry {
            command: format!("nx-rh-rs {}", b.cli.first().cloned().unwrap_or_default().join(" ")),
            id: b.id.to_string(),
            module: "platform".into(),
            usage: b.usage.to_string(),
            http: None,
            summary: b.summary.to_string(),
        })
        .collect()
}

/// 模块元数据（help 分组标题用）
pub fn module_title(module_id: &str) -> String {
    match module_id {
        "system" => "系统".into(),
        "worktrees" => "工作树（= Web「工作树」页）".into(),
        "skills" => "Skill（= Web「Skill」页）".into(),
        "settings" => "设置（= Web「设置」页）".into(),
        "env" => "环境变量".into(),
        "bundled" => "内置 skill 包".into(),
        "platform" => "平台命令".into(),
        other => other.to_string(),
    }
}

pub const MODULE_ORDER: [&str; 6] =
    ["system", "worktrees", "skills", "settings", "env", "bundled"];
