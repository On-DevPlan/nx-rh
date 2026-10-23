// 编程入口：供其他工具 / agent 以库方式调用。
// 导出的是各模块的 service（业务真相源），不是 CLI/HTTP 壳——库用方自己组织 I/O。
export * as store from './core/store.js';
export * as diff from './core/diff.js';
export * as errors from './core/errors.js';
export * as git from './core/git.js';
export * as gitignore from './core/gitignore.js';

// 仓库模块（repos）已于 2026-10-23 迁到 nx-kv（远程清单 topic=goal 的 #72）：
// 仓库登记是本机事实，它的价值是给「本地任务管理」当上下文，所以它跟着任务走。
// 库用方要仓库上下文请走 nx-kv（`nx-kv repo ...` / `nx-kv board ...`）。
export * as skills from './modules/skills/service.js';
export * as settings from './modules/settings/service.js';
export * as system from './modules/system/service.js';
export * as env from './modules/env/service.js';
export * as bundled from './modules/bundled/service.js';
export * as worktrees from './modules/worktrees/service.js';

export { ACTIONS, MODULES } from './runtime/registry.js';
export { startServer } from './runtime/server.js';
