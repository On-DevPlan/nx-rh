// 系统 service：跨作用域的「最近项目」列表。
//
// 这是 cwd 作用域方案的**全局共享**那一半——按 cwd 隔离的数据不存在这里，
// 这里只维护「用过哪些项目目录」，供面板顶部切换。
import { resolve } from 'node:path';
import { loadStore, mutateStore } from '../../core/store.js';
import { cwdScope } from '../../core/paths.js';
import { badInput } from '../../core/errors.js';

export const MAX_RECENTS = 20;

export async function listRecents() {
  return (await loadStore()).recents;
}

// 登记一个「最近项目」。同一 scope 只保留最新一条（path 用最新写法）。
export async function touchRecent(dir) {
  if (!dir) throw badInput('目录不能为空');
  const abs = resolve(String(dir));
  const scope = cwdScope(abs);
  return mutateStore((s) => {
    s.recents = s.recents.filter((r) => r.scope !== scope);
    s.recents.unshift({ scope, path: abs, lastUsedAt: new Date().toISOString() });
    s.recents = s.recents.slice(0, MAX_RECENTS);
    return s.recents;
  });
}

// 移除一条。移出不存在的项不算错误（与其他 remove 一致的幂等立场）。
export async function removeRecent(dir) {
  if (!dir) throw badInput('目录不能为空');
  const scope = cwdScope(resolve(String(dir)));
  return mutateStore((s) => {
    s.recents = s.recents.filter((r) => r.scope !== scope);
    return s.recents;
  });
}
