// 编程入口：供其他工具 / agent 以库方式调用。
// 导出的是各模块的 service（业务真相源），不是 CLI/HTTP 壳——库用方自己组织 I/O。
export * as store from './core/store.js';
export * as git from './core/git.js';
export * as diff from './core/diff.js';
export * as errors from './core/errors.js';

export * as repos from './modules/repos/service.js';
export * as skills from './modules/skills/service.js';
export * as settings from './modules/settings/service.js';
export * as env from './modules/env/service.js';
export * as bundled from './modules/bundled/service.js';
export * as github from './modules/github/service.js';

export { ACTIONS, MODULES } from './runtime/registry.js';
export { startServer } from './runtime/server.js';
