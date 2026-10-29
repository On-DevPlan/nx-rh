// 通用 CLI 运行器：解析 argv → 匹配 action → 校验 → 执行 → 渲染。
// 与 runtime/cli.js 行为逐条对齐：--json / --store / --help / boolean flag /
// 最长命令匹配（含路径里带 flag 的别名）/ 未知 flag 报错。

use std::collections::HashSet;
use std::io::Write;

use serde_json::{json, Value};

use crate::core::errors::{exit_code_of, to_error_payload, AppError};
use crate::core::paths::{self, set_startup_dir, DEFAULT_PORT};
use super::registry;
use super::spec::{
    apply_spec, arg_specs_of, boolean_flag_names, cli_paths_of, flag_specs_of, usage_of, Action,
};

pub use crate::runtime::VERSION;

// ---- 平台命令执行（不属于任何功能域）----

fn cmd_serve(ctx: &Value) -> crate::core::errors::Res<Value> {
    crate::server_cli::serve(ctx)
}

fn help_entries(topic: Option<&str>) -> crate::core::errors::Res<Vec<registry::CommandEntry>> {
    let mut all = registry::builtin_command_entries();
    for a in registry::actions() {
        all.push(registry::command_entry_of_action(a));
    }
    let Some(t) = topic else { return Ok(all) };
    let t = t.to_string();

    if registry::MODULE_ORDER.contains(&t.as_str()) {
        return Ok(all.into_iter().filter(|e| e.module == t).collect());
    }
    let by_root: Vec<_> = all
        .iter()
        .filter(|e| e.command.split(' ').nth(1) == Some(t.as_str()))
        .cloned()
        .collect();
    if !by_root.is_empty() {
        return Ok(by_root);
    }
    let by_id: Vec<_> = all.iter().filter(|e| e.id == t).cloned().collect();
    if !by_id.is_empty() {
        return Ok(by_id);
    }
    // 命令组名由已注册的命令表现推
    let roots: Vec<String> = all
        .iter()
        .filter_map(|e| e.command.split(' ').nth(1).map(|s| s.to_string()))
        .collect();
    let mut groups_set: Vec<String> = Vec::new();
    for r in &roots {
        if roots.iter().filter(|x| *x == r).count() > 1 && !groups_set.contains(r) {
            groups_set.push(r.clone());
        }
    }
    let groups = groups_set.into_iter().take(4).collect::<Vec<_>>().join(" / ");
    let mut topics: Vec<String> = Vec::new();
    for e in &all {
        if !topics.contains(&e.module) {
            topics.push(e.module.clone());
        }
    }
    Err(crate::core::errors::bad_input(format!(
        "未知帮助主题: {}（可用模块: {}；或命令组如 {}）",
        t,
        topics.join(", "),
        groups
    )))
}

fn render_help(entries: &[registry::CommandEntry], topic: Option<&str>) -> String {
    let mut lines: Vec<String> = Vec::new();
    if topic.is_none() {
        lines.push(format!("nx-rh-rs · npx-repo-hub v{}", VERSION));
        lines.push("本机仓库与 Agent Skill 管理中枢。CLI 与 Web 面板共享同一 action 声明。".to_string());
        lines.push(format!(
            "存储: {}    （环境变量 NX_RH_STORE 或 --store 覆盖）",
            paths::store_path_from_env().display()
        ));
        lines.push(String::new());
    }

    // 分组：按 entries 的**出现顺序**，不做二次排序。
    // JS 版就是插入序（平台命令在最前，其后按模块注册序）；
    // 早期这里按 MODULE_ORDER 重排过一次，结果「平台命令」被挤到最后，
    // help 版面从第 5 行起就和 JS 分叉了。
    let mut groups: Vec<(String, Vec<&registry::CommandEntry>)> = Vec::new();
    for e in entries {
        match groups.iter_mut().find(|(m, _)| *m == e.module) {
            Some((_, list)) => list.push(e),
            None => groups.push((e.module.clone(), vec![e])),
        }
    }

    for (module, list) in &groups {
        let title = registry::module_title(module);
        lines.push(format!("{}:", title));
        let width = list.iter().map(|e| e.usage.len()).max().unwrap_or(0);
        for e in list {
            lines.push(format!("  {:<width$}  {}", e.usage, e.summary, width = width + 2));
        }
        lines.push(String::new());
    }

    lines.push("通用:".to_string());
    lines.push("  --json    机器可读输出（agent 模式）".to_string());
    lines.push("  --store   本次运行覆盖存储路径".to_string());
    lines.join("\n")
}

fn print_command_help(cmd: &Action) {
    let mut lines = vec![usage_of(cmd).to_string()];
    if !cmd.summary.is_empty() {
        lines.push(format!("    {}", cmd.summary));
    }
    lines.push(String::new());
    let aliases: Vec<String> = cli_paths_of(cmd)
        .iter()
        .skip(1)
        .map(|p| format!("nx-rh-rs {}", p.join(" ")))
        .collect();
    if !aliases.is_empty() {
        lines.push(format!("别名: {}", aliases.join("  ·  ")));
    }
    if let Some((m, p)) = cmd.http {
        lines.push(format!("对应路由: {} {}", m, p));
    }
    lines.push(format!("所属模块: {}", cmd.module));
    println!("{}", lines.join("\n"));
}

// ---- 匹配与解析 ----

/// 匹配命令：把声明路径与 argv 前缀逐 token 比较，选最长匹配。
/// 返回 (action, 剩余 argv)。
fn resolve_action<'a>(argv: &[String]) -> Option<(&'a Action, Vec<String>)> {
    let mut best: Option<(&'a Action, usize)> = None;
    for cmd in registry::actions() {
        for path in cli_paths_of(cmd) {
            if path.len() > argv.len() {
                continue;
            }
            if let Some((_, best_len)) = best {
                if path.len() <= best_len {
                    continue;
                }
            }
            if path.iter().enumerate().all(|(i, seg)| *seg == argv[i]) {
                best = Some((cmd, path.len()));
            }
        }
    }
    best.map(|(cmd, len)| (cmd, argv[len..].to_vec()))
}

/// 全局 flag 摘除：--json / --store
fn split_globals(argv: &[String]) -> (Vec<String>, bool, Option<String>) {
    let mut rest = Vec::new();
    let mut json = false;
    let mut store: Option<String> = None;
    let mut i = 0;
    while i < argv.len() {
        let a = &argv[i];
        if a == "--json" {
            json = true;
        } else if a == "--store" {
            i += 1;
            store = argv.get(i).cloned();
        } else if let Some(v) = a.strip_prefix("--store=") {
            store = Some(v.to_string());
        } else {
            rest.push(a.clone());
        }
        i += 1;
    }
    (rest, json, store)
}

struct Parsed {
    positionals: Vec<String>,
    flags: std::collections::BTreeMap<String, Value>,
}

/// 解析剩余 token。布尔 flag 不吞下一个 token。
fn parse_rest(rest: &[String], cmd: &Action) -> Parsed {
    let bools = boolean_flag_names(cmd);
    let mut positionals = Vec::new();
    let mut flags = std::collections::BTreeMap::new();
    let mut i = 0;
    while i < rest.len() {
        let a = &rest[i];
        if !a.starts_with("--") {
            positionals.push(a.clone());
            i += 1;
            continue;
        }
        if let Some(eq) = a.find('=') {
            if eq > 2 {
                flags.insert(a[2..eq].to_string(), Value::String(a[eq + 1..].to_string()));
                i += 1;
                continue;
            }
        }
        let key = &a[2..];
        let next = rest.get(i + 1);
        if !bools.contains(key) {
            if let Some(n) = next {
                if !n.starts_with("--") {
                    flags.insert(key.to_string(), Value::String(n.clone()));
                    i += 2;
                    continue;
                }
            }
        }
        flags.insert(key.to_string(), Value::Bool(true));
        i += 1;
    }
    Parsed { positionals, flags }
}

/// 位置参数按声明顺序映射成具名输入；末尾声明 rest 的收集剩余全部。
fn map_positionals(positionals: &[String], cmd: &Action) -> Result<Value, AppError> {
    let mut out = serde_json::Map::new();
    let mut i = 0;
    let mut consumed_all = false;
    for spec in arg_specs_of(cmd) {
        if spec.rest {
            let arr: Vec<Value> = positionals[i..]
                .iter()
                .map(|s| Value::String(s.clone()))
                .collect();
            out.insert(spec.name.to_string(), Value::Array(arr));
            i = positionals.len();
            consumed_all = true;
            break;
        }
        if let Some(p) = positionals.get(i) {
            out.insert(spec.name.to_string(), Value::String(p.clone()));
        }
        i += 1;
    }
    if !consumed_all && i < positionals.len() {
        return Err(crate::core::errors::bad_input(format!(
            "多余的参数: {}（用法见 nx-rh-rs help）",
            positionals[i..].join(" ")
        )));
    }
    Ok(Value::Object(out))
}

/// 未知 flag 直接报错（--fiile 这类拼写错误要立刻被指出）。
fn assert_known_flags(flags: &std::collections::BTreeMap<String, Value>, cmd: &Action) -> Result<(), AppError> {
    let known: HashSet<&str> = flag_specs_of(cmd).iter().map(|f| f.name).collect();
    for k in flags.keys() {
        if !known.contains(k.as_str()) {
            return Err(crate::core::errors::bad_input(format!(
                "未知参数 --{}（用法见 nx-rh-rs help）",
                k
            )));
        }
    }
    Ok(())
}

// ---- 输出 ----

/// render 拿到 (data, ctx)。--json 走纯序列化。
fn emit(cmd: &Action, data: Value, json: bool, ctx: &Value) {
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&data).unwrap_or_else(|_| "null".into())
        );
        return;
    }
    if let Some(render) = cmd.render {
        let text = render(&data, ctx);
        if !text.is_empty() {
            println!("{}", text);
        }
        return;
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&data).unwrap_or_else(|_| "null".into())
    );
}

/// 失败一律 exit 1；--json 下输出可解析的错误对象（error 保持字符串，code 新增）。
fn fail(err: &AppError, json: bool) {
    if json {
        let mut payload = json!({ "ok": false, "error": err.message, "code": err.code });
        if let Some(d) = &err.details {
            payload["details"] = d.clone();
        }
        println!("{}", serde_json::to_string_pretty(&payload).unwrap_or_default());
    } else {
        eprintln!("错误: {}", err.message);
    }
    std::process::exit(exit_code_of(&err.code));
}

/// 主入口。
pub fn run_cli(argv: Vec<String>) {
    let argv: Vec<String> = argv.into_iter().skip(1).collect(); // 跳过 argv[0]
    let (rest, json, store) = split_globals(&argv);
    if let Some(s) = store {
        std::env::set_var("NX_RH_STORE", s);
    }

    // 平台命令：help / version / serve
    if let Some(first) = rest.first() {
        match first.as_str() {
            "version" => {
                if json {
                    println!("{}", serde_json::to_string_pretty(&json!(VERSION)).unwrap());
                } else {
                    println!("{}", VERSION);
                }
                return;
            }
            "help" => {
                let topic = rest.get(1).map(|s| s.as_str());
                // --help flag 混入也容忍
                let topic = topic.filter(|t| *t != "--help");
                match help_entries(topic) {
                    Ok(entries) => {
                        if json {
                            let arr: Vec<Value> = entries
                                .iter()
                                .map(|e| {
                                    json!({
                                        "id": e.id, "module": e.module, "command": e.command,
                                        "usage": e.usage,
                                        "http": e.http.as_ref().map(|(m,p)| json!({"method": m, "path": p})),
                                        "summary": e.summary,
                                    })
                                })
                                .collect();
                            println!("{}", serde_json::to_string_pretty(&arr).unwrap());
                        } else {
                            println!("{}", render_help(&entries, topic));
                        }
                    }
                    Err(e) => fail(&e, json),
                }
                return;
            }
            "serve" => {
                let action = ServeAction;
                let input = build_input(&rest[1..], &action as &dyn DynAction);
                match input.and_then(|input| {
                    apply_dyn(&action, &input).and_then(|data| Ok((data, input)))
                }) {
                    Ok((data, input)) => {
                        if json {
                            println!("{}", serde_json::to_string_pretty(&data).unwrap_or_default());
                        } else if let Some(r) = data.as_str() {
                            println!("{}", r);
                        }
                        let _ = input;
                    }
                    Err(e) => fail(&e, json),
                }
                return;
            }
            _ => {}
        }
    }

    if rest.is_empty() {
        match help_entries(None) {
            Ok(entries) => println!("{}", render_help(&entries, None)),
            Err(e) => fail(&e, json),
        }
        return;
    }

    let Some((cmd, tail)) = resolve_action(&rest) else {
        eprintln!("未知命令: {}", rest.join(" "));
        eprintln!("运行 nx-rh-rs help 查看用法");
        std::process::exit(1);
    };

    if tail.iter().any(|t| t == "--help") {
        print_command_help(cmd);
        return;
    }

    let run = || -> Result<Value, AppError> {
        let parsed = parse_rest(&tail, cmd);
        assert_known_flags(&parsed.flags, cmd)?;
        let mut input = map_positionals(&parsed.positionals, cmd)?;
        if let Some(obj) = input.as_object_mut() {
            for (k, v) in parsed.flags {
                obj.insert(k, v);
            }
        }
        let ctx = apply_spec(cmd, &input)?;
        let data = (cmd.run)(&ctx, "cli")?;
        Ok(data)
    };

    match run() {
        Ok(data) => emit(cmd, data, json, &Value::Null),
        Err(e) => fail(&e, json),
    }
}

// ---- serve 的动态 action 适配（复用解析管线）----

trait DynAction {
    fn arg_specs(&self) -> Vec<super::spec::ArgSpec>;
    fn flag_specs(&self) -> Vec<super::spec::FlagSpec>;
}

struct ServeAction;

impl DynAction for ServeAction {
    fn arg_specs(&self) -> Vec<super::spec::ArgSpec> {
        vec![super::spec::ArgSpec { name: "dir", required: false, rest: false }]
    }
    fn flag_specs(&self) -> Vec<super::spec::FlagSpec> {
        vec![
            super::spec::FlagSpec {
                name: "port",
                kind: "number",
                required: false,
                default: Some(json!(DEFAULT_PORT)),
                enum_values: None,
                hint: "",
            },
            super::spec::FlagSpec {
                name: "no-open",
                kind: "boolean",
                required: false,
                default: None,
                enum_values: None,
                hint: "",
            },
        ]
    }
}

fn build_input(rest: &[String], action: &dyn DynAction) -> Result<Value, AppError> {
    let bools: HashSet<&str> = action.flag_specs().iter().filter(|f| f.kind == "boolean").map(|f| f.name).collect();
    let mut positionals = Vec::new();
    let mut flags = serde_json::Map::new();
    let mut i = 0;
    while i < rest.len() {
        let a = &rest[i];
        if !a.starts_with("--") {
            positionals.push(a.clone());
            i += 1;
            continue;
        }
        if let Some(eq) = a.find('=') {
            if eq > 2 {
                flags.insert(a[2..eq].to_string(), Value::String(a[eq + 1..].to_string()));
                i += 1;
                continue;
            }
        }
        let key = &a[2..];
        let next = rest.get(i + 1);
        if !bools.contains(key) {
            if let Some(n) = next {
                if !n.starts_with("--") {
                    flags.insert(key.to_string(), Value::String(n.clone()));
                    i += 2;
                    continue;
                }
            }
        }
        flags.insert(key.to_string(), Value::Bool(true));
        i += 1;
    }
    let known: HashSet<&str> = action.flag_specs().iter().map(|f| f.name).collect();
    for k in flags.keys() {
        if !known.contains(k.as_str()) {
            return Err(crate::core::errors::bad_input(format!(
                "未知参数 --{}（用法见 nx-rh-rs help）",
                k
            )));
        }
    }
    let mut out = serde_json::Map::new();
    let arg_specs = action.arg_specs();
    if let Some(p) = positionals.first() {
        if let Some(spec) = arg_specs.first() {
            out.insert(spec.name.to_string(), Value::String(p.clone()));
        }
    }
    for (k, v) in flags {
        out.insert(k, v);
    }
    Ok(Value::Object(out))
}

fn apply_dyn(action: &ServeAction, input: &Value) -> Result<Value, AppError> {
    // flag 默认值与强转
    let mut ctx = input.clone();
    let obj = ctx.as_object_mut().unwrap();
    for spec in action.flag_specs() {
        let v = obj.get(spec.name).cloned();
        match v {
            None | Some(Value::Null) => {
                if let Some(d) = spec.default {
                    obj.insert(spec.name.to_string(), d);
                }
            }
            Some(Value::String(s)) if spec.kind == "number" => {
                let n: f64 = s.parse().map_err(|_| {
                    crate::core::errors::bad_input(format!("参数 {} 必须是数字，收到: {}", spec.name, s))
                })?;
                obj.insert(spec.name.to_string(), json!(n));
            }
            Some(v) => {
                obj.insert(spec.name.to_string(), v);
            }
        }
    }
    cmd_serve(&ctx)
}

// 输出缓冲 flush（Windows 终端下防截断）
pub fn flush_stdout() {
    let _ = std::io::stdout().flush();
}

// set_startup_dir 供 serve 用；这里引用防未用
#[allow(dead_code)]
fn _touch() {
    set_startup_dir(None);
    let _ = to_error_payload(&AppError { code: "INTERNAL".into(), message: String::new(), details: None });
}
