// 工作树模块 service：业务真相源。
// 不认识 argv 也不认识 HTTP——输入都是普通对象，输出都是普通数据。
//
// 与 repos 模块的边界：repos 仍只登记仓库、不碰 git；**本模块独占 git-worktree
// 操作**（worktree add/remove/rebase 等），不做通用的 status/diff/pull/push。
// 工作树清单以 git 为唯一真相，store 只登记 git 不知道的东西：
//   - 扩展文件（.gitignore 里那些不会被 worktree 带走的文件）的全路径与指纹
//   - 模块配置（分支前缀 / 工作树根 / 基础分支 / 同步方式）
//
// 本文件是 barrel：领域文件在 svc/ 下，导出面与拆分前完全一致。
// 依赖序（单向，不许成环）：
//   bucket ← inspect ← list ← { config, wt, context, ext, sync, rebase }
// 一个导出名只允许活在一个 svc 文件里——`export *` 对重名会**静默丢弃**。
export * from './svc/bucket.js';
export * from './svc/inspect.js';
export * from './svc/list.js';
export * from './svc/config.js';
export * from './svc/wt.js';
export * from './svc/context.js';
export * from './svc/ext.js';
export * from './svc/rebase.js';
