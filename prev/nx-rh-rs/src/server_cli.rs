// serve 命令实现：端口协商（reuse/shift）+ 起服务 + 开浏览器。

use serde_json::{json, Value};

use super::core::paths::{self, set_startup_dir, DEFAULT_PORT};
use super::core::serve_port;
use crate::runtime::http::{serve_loop, start_server, ServerOptions};
use crate::runtime::VERSION;

/// 嵌入的前端静态资源（构建时从 frontend/ 拷进来）
pub static STATIC_ROOT: include_dir::Dir = include_dir::include_dir!("$CARGO_MANIFEST_DIR/frontend");

pub fn serve(ctx: &Value) -> super::core::errors::Res<Value> {
    let dir = ctx.get("dir").and_then(|d| d.as_str()).map(|s| s.to_string());
    set_startup_dir(dir.as_deref().map(std::path::Path::new));

    let desired_port = ctx
        .get("port")
        .and_then(|p| p.as_f64())
        .map(|f| f as u16)
        .unwrap_or(DEFAULT_PORT);
    let host: &'static str = "127.0.0.1";
    let no_open = ctx.get("no-open").and_then(|v| v.as_bool()).unwrap_or(false);
    let can_open = serve_port::auto_open_enabled(no_open);

    // 静态资源直接从嵌入树读（不落盘）——单文件分发的前提

    let app_name = paths::APP_NAME;
    let listener = match start_server(ServerOptions {
        port: desired_port,
        host,
    }) {
        Ok(l) => l,
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            let decision = serve_port::resolve_port_conflict(desired_port, app_name)
                .map_err(|e| super::core::errors::external(e.to_string()))?;
            if decision.action == "reuse" {
                let addr = format!("http://{}:{}", host, desired_port);
                let scope = decision
                    .existing
                    .as_ref()
                    .and_then(|d| d.get("cwdScope"))
                    .and_then(|c| c.as_str())
                    .map(|s| s.to_string());
                println!("nx-rh-rs · npx-repo-hub(rust) v{}", VERSION);
                println!(
                    "已在运行的面板: {}{}",
                    addr,
                    scope.map(|s| format!("  （作用域 {}）", s)).unwrap_or_default()
                );
                let project = paths::project_root().to_string_lossy().to_string();
                println!("已登记为最近项目: {}", project);
                let _ = crate::modules::system::service::touch_recent(&project);
                if can_open {
                    super::core::open::open_browser(&addr);
                }
                return Ok(Value::Null);
            }
            println!(
                "端口 {} 已被占用（占用者: {}），改用 {}",
                desired_port,
                serve_port::describe_occupant(&decision.occupant),
                decision.port
            );
            start_server(ServerOptions {
                port: decision.port,
                host,
                    })
            .map_err(|e| super::core::errors::external(format!("监听失败: {}", e)))?
        }
        Err(e) => return Err(super::core::errors::external(format!("监听失败: {}", e))),
    };

    let port = listener.local_addr().map(|a| a.port()).unwrap_or(desired_port);
    let addr = format!("http://{}:{}", host, port);

    println!("nx-rh-rs · npx-repo-hub(rust) v{}", VERSION);
    println!("面板:   {}", addr);
    println!("项目:   {}", paths::project_root().display());
    println!("作用域: {}", paths::cwd_scope(None));
    println!("存储:   {}", paths::store_path_from_env().display());
    println!("CLI:    nx-rh-rs help（每个按钮都有对应命令，agent 可加 --json）");
    println!("按 Ctrl+C 停止");

    // 登记「最近项目」失败不阻塞启动
    let _ = crate::modules::system::service::touch_recent(&paths::project_root().to_string_lossy());

    if can_open {
        super::core::open::open_browser(&addr);
    }

    serve_loop(listener, &STATIC_ROOT);
    Ok(json!({ "addr": addr }))
}

