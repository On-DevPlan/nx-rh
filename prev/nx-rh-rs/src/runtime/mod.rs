// runtime 模块：装配层，把 action 表编译成 CLI 命令表与 HTTP 路由表。

pub mod cli;
pub mod http;
pub mod registry;
pub mod spec;

/// 版本号（与 package.json 保持一致）
pub const VERSION: &str = crate::VERSION;
