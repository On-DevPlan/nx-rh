// nx-rh-rs（npx-repo-hub Rust 试验版）唯一入口。
// 设计约定：Web 面板上每个按钮，都对应这里的一条 CLI 命令——二者由同一份
// action 声明派生（见 src/modules/*/mod.rs），不是靠人维护两份清单。

pub const VERSION: &str = "0.18.0";

// 模块根在 src/ 下（bin/ 只是入口文件），用 #[path] 显式指路。
#[path = "../src/core/mod.rs"]
mod core;
#[path = "../src/modules/mod.rs"]
mod modules;
#[path = "../src/runtime/mod.rs"]
mod runtime;
#[path = "../src/server_cli.rs"]
mod server_cli;

#[cfg(test)]
#[path = "../src/tests.rs"]
mod tests;

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    runtime::cli::run_cli(argv);
    runtime::cli::flush_stdout();
}
