// 订阅源（Skill Hub）的登记与列举：唯一可信源的管理面。
// scan 是本文件的下层；跨模块的 settings 导入是 eslint 唯一放行的例外。
import { resolve, join } from 'node:path';
import fsp from 'node:fs/promises';
import { exists, pathExists } from '../../../core/fstree.js';
import { badInput, notFound } from '../../../core/errors.js';
import {
  getSettings,
  hubPath,
  setHubPath,
  addCandidate,
  removeCandidate,
} from '../../settings/service.js';
import { resolveSkillsRoot, scanSkillsRoot, readSkill } from './scan.js';

// 订阅源清单，附带解析后的 skills 根、是否存在、skill 数、是否当前主源
export async function listSources() {
  const s = await getSettings();
  const current = s.skillHubPath ? resolve(s.skillHubPath) : '';
  const out = [];
  for (const p of s.skillHubSources) {
    const abs = resolve(p);
    const root = await resolveSkillsRoot(abs);
    const skills = await scanSkillsRoot(root, { realOnly: true });
    out.push({
      path: abs,
      root,
      exists: await pathExists(abs),
      count: skills.length,
      current: abs.toLowerCase() === current.toLowerCase(),
    });
  }
  return { current, sources: out };
}

export async function addSource(path) {
  if (!path) throw badInput('path 不能为空');
  const abs = resolve(String(path));
  if (!(await pathExists(abs))) throw notFound('订阅源目录不存在: ' + abs);
  await addCandidate('hub', abs); // 新增即设为主源
  return listSources();
}

export async function removeSource(path) {
  await removeCandidate('hub', path);
  return listSources();
}

export async function setSource(path) {
  await setHubPath(path);
  return listSources();
}

// 当前订阅源（主 Skill Hub）的基本信息：未订阅时返回 { path:'', root:'' }
export async function hubInfo() {
  const p = await hubPath();
  if (!p) return { path: '', root: '', exists: false, count: 0 };
  const root = await resolveSkillsRoot(p);
  return { path: p, root, exists: await pathExists(p), count: (await scanSkillsRoot(root, { realOnly: true })).length };
}

// 当前订阅源的 skill 列表（主源为空时返回空数组，不报错——面板首屏要能渲染）
export async function listHubSkills() {
  const p = await hubPath();
  if (!p) return [];
  const root = await resolveSkillsRoot(p);
  return scanSkillsRoot(root, { source: p, realOnly: true });
}

// 全部订阅源的 skill 池（只认实文件，链接是别处真相源的落地副本不算来源）。
// 主源在前；同名去重留第一份——同名不同内容的真冲突不在这里判，
// 由 migrate 的 sourceEntriesFor 判定（blocked / --source 显式指定）。
export async function listAllSourceSkills() {
  const { sources } = await listSources();
  const ordered = [...sources].sort((a, b) => Number(b.current) - Number(a.current));
  const byName = new Map();
  for (const s of ordered) {
    if (!s.exists) continue;
    const skills = await scanSkillsRoot(s.root, { source: s.path, realOnly: true });
    for (const sk of skills) if (!byName.has(sk.name)) byName.set(sk.name, sk);
  }
  return [...byName.values()];
}

// 一个 skill 名在**实文件**层面出现在哪些订阅源（链接不算，见 scanSkillsRoot）。
// 出现 ≥2 个且内容不同 = 真冲突：两个真相源打架，迁移前必须先解决或显式 --source。
export async function sourceEntriesFor(name) {
  const { sources } = await listSources();
  const ordered = [...sources].sort((a, b) => Number(b.current) - Number(a.current));
  const out = [];
  for (const s of ordered) {
    if (!s.exists) continue;
    const dir = join(s.root, name);
    const lst = await fsp.lstat(dir).catch(() => null);
    if (!lst || lst.isSymbolicLink() || !lst.isDirectory()) continue;
    if (!(await exists(join(dir, 'SKILL.md')))) continue;
    const info = await readSkill(dir);
    info.source = s.path;
    out.push(info);
  }
  return out;
}

// 在全部订阅源里找一个 skill，主源优先；返回首个命中，并附 alsoIn（可重叠的其他源）
export async function findSourceSkill(name) {
  const entries = await sourceEntriesFor(name);
  if (!entries.length) return null;
  const [hit, ...rest] = entries;
  if (rest.length) hit.alsoIn = rest.map((e) => e.source);
  return hit;
}
