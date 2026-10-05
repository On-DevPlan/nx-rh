// Skill service：以「订阅源（Skill Hub）」为唯一可信源，把 skill 迁移到各平台目录。
//
// 本文件是 barrel：领域文件在 svc/ 下，导出面与拆分前完全一致。
// 模型（见 svc/ 内各文件的注释）：
//   source（订阅源）  被订阅的 skill 目录（目录下直接是各 skill；也兼容 <dir>/skills/）
//   target（迁移目标） platform × scope 的组合目录，如 ~/.claude/skills、<proj>/.workbuddy/skills
//
// 方向只有两条：source → target（迁移 migrate）、target → source（提交 submit）。
// 不做「项目之间互迁」——项目目录只是落地副本，真相永远在订阅源里。
//
// 依赖序（单向，不许成环）：
//   scan ← sources/targets ← queries ← select ← transfer
// 一个导出名只允许活在一个 svc 文件里——`export *` 对重名会**静默丢弃**。
export * from './svc/scan.js';
export * from './svc/sources.js';
export * from './svc/targets.js';
export * from './svc/queries.js';
export * from './svc/select.js';
export * from './svc/entity.js';
export * from './svc/transfer.js';
