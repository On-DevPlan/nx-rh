// 作用域隔离层：把「当前项目目录」放进 AsyncLocalStorage，整条 async 链自动可见。
//
// 为什么单开一个文件：它是 Node 专属能力（node:async_hooks），而 paths.js 会被
// 前端经 vite 间接引用到（模块边界靠 lint 兜底，但少一个入口就少一次踩雷机会）。
// 隔离在这里，前端永远碰不到。
import { AsyncLocalStorage } from 'node:async_hooks';

export const scopeStorage = new AsyncLocalStorage();

export function currentScope() {
  return scopeStorage.getStore() || null;
}

// 在一次作用域里执行 fn。Web 端由 api.js 用 x-nx-rh-scope 头激活，
// 于是业务代码一行不改就能读到「面板当前选的是哪个项目」。
export function runInScope(dir, fn) {
  return scopeStorage.run({ scope: dir, dir }, fn);
}
