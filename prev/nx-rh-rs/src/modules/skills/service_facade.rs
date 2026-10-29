// skills 的 service 门面：给 system bootstrap 用的聚合读取。
// Rust 侧没有 barrel export *，用一个显式结构体代替（语义与 service.js 一致）。

pub struct SkillsService;

impl SkillsService {
    pub fn hub_info(&self) -> serde_json::Value {
        super::sources::hub_info()
    }

    pub fn list_sources(&self) -> serde_json::Value {
        super::sources::list_sources().unwrap_or_else(|_| serde_json::json!({ "current": "", "sources": [] }))
    }
}

pub fn service() -> SkillsService {
    SkillsService
}
