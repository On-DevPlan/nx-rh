// 编程入口：供其他工具 / agent 以库方式调用，与 CLI、Web 共享同一 service 层。
export * as store from './core/store.js';
export * as git from './core/git.js';
export * as diff from './core/diff.js';
export * as repos from './services/repos.js';
export * as skills from './services/skills.js';
export { startServer } from './web/server.js';
