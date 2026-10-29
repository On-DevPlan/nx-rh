// 错误契约：失败抛 AppError，业务结果返回 status —— 与 JS 版 core/errors.js 逐条对齐。
//
// - 失败（参数非法、目标不存在、外部命令挂掉）→ Err(AppError)，API 映射 4xx/5xx，
//   CLI 映射 exit 1 + 可解析文本
// - 业务结果（冲突等待选侧、幂等跳过、规则阻止删除）→ Ok(value 里的 status 字段)，
//   绝不当错误抛
//
// 兼容约束：错误文本里的「用法:」「未设置」「不存在」是对外契约锚点，不得删除。

use serde::Serialize;

pub const INVALID_INPUT: &str = "INVALID_INPUT";
pub const NOT_FOUND: &str = "NOT_FOUND";
pub const CONFLICT: &str = "CONFLICT";
pub const BLOCKED: &str = "BLOCKED";
pub const EXTERNAL: &str = "EXTERNAL";
pub const INTERNAL: &str = "INTERNAL";

#[derive(Debug, Clone, Serialize)]
pub struct AppError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for AppError {}

pub fn http_status_of(code: &str) -> u16 {
    match code {
        INVALID_INPUT => 400,
        NOT_FOUND => 404,
        CONFLICT => 409,
        BLOCKED => 409,
        EXTERNAL => 502,
        _ => 500,
    }
}

pub fn exit_code_of(_code: &str) -> i32 {
    1
}

/// 任意错误归一成 { code, message, details }。AppError 原样保留 code/details。
pub fn to_error_payload(err: &AppError) -> AppError {
    err.clone()
}

pub fn app_error(code: &str, message: impl Into<String>) -> AppError {
    AppError { code: code.into(), message: message.into(), details: None }
}

pub fn bad_input(message: impl Into<String>) -> AppError {
    app_error(INVALID_INPUT, message)
}

pub fn not_found(message: impl Into<String>) -> AppError {
    app_error(NOT_FOUND, message)
}

pub fn conflict(message: impl Into<String>) -> AppError {
    app_error(CONFLICT, message)
}

pub fn blocked(message: impl Into<String>) -> AppError {
    app_error(BLOCKED, message)
}

pub fn external(message: impl Into<String>) -> AppError {
    app_error(EXTERNAL, message)
}

/// 全库统一 Result：service 层返回它，runtime 层统一收口。
pub type Res<T> = Result<T, AppError>;

/// 把 anyhow 上下文错误转成 Res（供 anyhow 生态的 IO 调用 `.map_err` 用）
pub fn io_err(e: std::io::Error) -> AppError {
    app_error(INTERNAL, e.to_string())
}
