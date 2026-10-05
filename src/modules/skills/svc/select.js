// 批量选择（--all / --include / --exclude / --match）：
// 全量迁移时「手点 N 次」既慢又容易漏；而「全都要，除了某几个」才是真实需求，
// 所以 --exclude 是一等参数。migrate / unmigrate / submit 共用这一套。
import { badInput, notFound } from '../../../core/errors.js';
import { listAllSourceSkills, listHubSkills } from './sources.js';
import { listAllSkills } from './queries.js';

// 名称模式：含 * 走通配（`gh-*`），否则按子串；都不区分大小写。
export function matchName(name, pattern) {
  const n = String(name).toLowerCase();
  const p = String(pattern || '').toLowerCase().trim();
  if (!p) return false;
  if (p.includes('*')) {
    const re = new RegExp(
      '^' + p.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'
    );
    return re.test(n);
  }
  return n.includes(p);
}

// 名称入参归一：CLI 的 rest 位置参数是数组，HTTP body / 面板传来的是单个字符串
export function nameList(v) {
  if (!v) return [];
  return (Array.isArray(v) ? v : [v]).map((x) => String(x).trim()).filter(Boolean);
}

export function applyFilters(list, { include, exclude, match } = {}) {
  let out = list;
  if (include && include.length) out = out.filter((s) => include.some((p) => matchName(s.name, p)));
  if (exclude && exclude.length) out = out.filter((s) => !exclude.some((p) => matchName(s.name, p)));
  if (match) {
    const q = String(match).toLowerCase();
    out = out.filter((s) => String(s.description || '').toLowerCase().includes(q));
  }
  return out;
}

// 从订阅源里筛出要操作的 skill。
// 显式点名 → 在**全部**已订阅源里找（名字就是明确意图；少一个就报错，
// 避免批量里静默漏迁移；同名不同内容仍由 migrate 判 blocked / --source）。
// --all / --include 全量 → 只取**当前主源**（「把主源铺出去」的语义，
// 不然订阅十个源时 --all 会把所有源全铺一遍，谁都 hold 不住）。
export async function selectSourceSkills({ names, all, include, exclude, match } = {}) {
  const wanted = nameList(names);
  const pool = wanted.length ? await listAllSourceSkills() : await listHubSkills();
  const byName = new Map(pool.map((s) => [s.name, s]));

  let chosen;
  if (wanted.length) {
    const missing = wanted.filter((n) => !byName.has(n));
    if (missing.length) throw notFound(`订阅源里没有这些 skill: ${missing.join(', ')}`);
    chosen = wanted.map((n) => byName.get(n));
  } else if (all || (include && include.length)) {
    chosen = [...pool];
  } else {
    throw badInput('需要 <name...>、--all 或 --include <模式> 之一');
  }

  const out = applyFilters(chosen, { include, exclude, match });
  if (!out.length) throw notFound('按当前筛选条件没有匹配的 skill（--exclude / --match 把候选排空了吗？）');
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// 撤销/提交的候选池来自**目标目录的扫描**（含不在订阅源的游离 skill）。
// 供 transfer（unmigrate / submit）复用；它依赖 queries 的 listAllSkills，
// 若未来出现环，把它挪进 transfer.js（唯一调用方是 unmigrateSkill / submitSkill）。
export async function collectTargetSkills({ project }) {
  const scan = await listAllSkills({ project });
  const map = new Map();
  for (const x of scan.skills) map.set(x.name, x.description || '');
  for (const x of scan.orphans) map.set(x.name, x.description || '');
  return [...map].map(([name, description]) => ({ name, description }));
}
