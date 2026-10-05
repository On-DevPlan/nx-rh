// Skill service：以「订阅源（Skill Hub）」为唯一可信源，把 skill 迁移到各平台目录。
//
// 模型：
//   source（订阅源）  被订阅的 skill 目录（目录下直接是各 skill；也兼容 <dir>/skills/）
//   target（迁移目标） platform × scope 的组合目录，如 ~/.claude/skills、<proj>/.workbuddy/skills
//
// 方向只有两条：source → target（迁移 migrate）、target → source（提交 submit）。
// 不做「项目之间互迁」——项目目录只是落地副本，真相永远在订阅源里。
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import fsp from 'node:fs/promises';
import { exists, pathExists, md5Of, diffTrees } from '../../core/fstree.js';
import { parseFrontmatter } from '../../core/frontmatter.js';
import { mdOutline, mdStats } from '../../core/mdoutline.js';
import { detectLinkType, createSkillLink, sameRealPath, samePath } from '../../core/link.js';
import { assertSafeName, assertSafeRelPath, projectRoot, cwdScope } from '../../core/paths.js';
import { badInput, notFound, conflict } from '../../core/errors.js';
import { ADAPTERS, SCOPES, adapterById, targetDirFor, platformNames } from './adapters.js';
import {
  getSettings,
  hubPath,
  requireHubPath,
  setHubPath,
  addCandidate,
  removeCandidate,
} from '../settings/service.js';

const SCOPE_IDS = SCOPES.map((s) => s.id);

// ─── 单个 skill 目录读取 ────────────────────────────────────────────

async function readSkill(dir) {
  const mdPath = join(dir, 'SKILL.md');
  const raw = await fsp.readFile(mdPath, 'utf8').catch(() => null);
  if (raw === null) return null;
  const fm = parseFrontmatter(raw);
  const st = await fsp.stat(mdPath).catch(() => null);
  return {
    name: fm.name || basename(dir),
    description: fm.description || '(无描述)',
    dir,
    md5: md5Of(Buffer.from(raw, 'utf8')),
    lastModified: st ? st.mtime.toISOString() : '',
    linkType: await detectLinkType(dir),
  };
}

// 订阅源目录里可能直接是 skill，也可能包一层 skills/。逐个探测：
// 先看目录本身是否含 skill 子目录，否则退回 <dir>/skills。
async function resolveSkillsRoot(sourcePath) {
  const direct = await countSkillDirs(sourcePath);
  if (direct > 0) return sourcePath;
  const nested = join(sourcePath, 'skills');
  if (await countSkillDirs(nested)) return nested;
  return sourcePath; // 空源：仍返回自身，便于报「0 个 skill」
}

async function countSkillDirs(root) {
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  let n = 0;
  for (const e of entries) {
    if (!e.name || e.name.startsWith('.')) continue;
    // 来源只认**实文件**：链接是别的真相源的落地副本，不算来源
    const lst = await fsp.lstat(join(root, e.name)).catch(() => null);
    if (!lst || lst.isSymbolicLink() || !lst.isDirectory()) continue;
    if (await exists(join(root, e.name, 'SKILL.md'))) n++;
  }
  return n;
}

// 扫描一个 skills 根目录下的一级子目录（每个即一个 skill）。
//
// realOnly（来源侧恒为 true）：只认实文件。源目录里的链接是**别的真相源**的落地副本
// （典型：把 ~/.claude/skills 订阅为临时来源，里面大半是指向 sl 的链接）——
// 把它们当来源会造成「同名 skill 出现在多个源」的假冲突，而且违背
// 「唯一实文件 = 订阅源」：链接本来就不是实文件。
// 目标侧（realOnly=false）则照常识别链接形态，那是迁移的结果。
async function scanSkillsRoot(root, { source, realOnly } = {}) {
  const out = [];
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.name || e.name.startsWith('.')) continue;
    const dir = join(root, e.name);
    const lst = await fsp.lstat(dir).catch(() => null);
    if (!lst) continue;
    if (!lst.isDirectory() && !lst.isSymbolicLink()) continue;
    const info = await readSkill(dir);
    if (info) {
      if (realOnly && info.linkType) continue;
      if (source) info.source = source;
      out.push(info);
      continue;
    }
    if (realOnly) continue; // 悬空链接在来源侧是噪音，不是 skill
    const lt = lst.isSymbolicLink() ? 'symlink' : await detectLinkType(dir);
    if (lt) {
      out.push({
        name: e.name,
        description: '(链接目标缺失，可清理)',
        dir,
        md5: '',
        lastModified: '',
        linkType: lt,
        source,
      });
    }
  }
  return out;
}

// ─── 订阅源 ─────────────────────────────────────────────────────────

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
async function sourceEntriesFor(name) {
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
async function findSourceSkill(name) {
  const entries = await sourceEntriesFor(name);
  if (!entries.length) return null;
  const [hit, ...rest] = entries;
  if (rest.length) hit.alsoIn = rest.map((e) => e.source);
  return hit;
}

// ─── 来源健康与冲突检测 ─────────────────────────────────────────────
//
// 订阅源是唯一可信源，因此**来源之间本不该有冲突**。出现同名实文件 =
// 订阅配置有问题（嵌套订阅 / 同一仓库重复订阅 / 两个仓库各放了一份且内容不同）。
// 目的仓库**不参与**冲突检测：它只是落地副本，直接被订阅源覆盖即可。

export async function sourceAudit() {
  const { current, sources } = await listSources();
  const hubProblems = hubProblemsFor(sources);

  const byName = new Map();
  for (const src of sources) {
    if (!src.exists) continue;
    for (const sk of await scanSkillsRoot(src.root, { source: src.path, realOnly: true })) {
      const arr = byName.get(sk.name) || [];
      arr.push({ source: src.path, dir: sk.dir, md5: sk.md5, current: src.path === current });
      byName.set(sk.name, arr);
    }
  }
  const conflicts = [];
  for (const [name, entries] of byName) {
    if (entries.length < 2) continue;
    const same = entries.every((e) => e.md5 === entries[0].md5);
    conflicts.push({ name, kind: same ? 'duplicate' : 'conflict', same, entries });
  }
  conflicts.sort((a, b) => a.name.localeCompare(b.name));

  return {
    current,
    sources,
    hubProblems,
    conflicts,
    ok: hubProblems.length === 0 && conflicts.filter((c) => !c.same).length === 0,
    summary: {
      sources: sources.length,
      hubProblems: hubProblems.length,
      conflicts: conflicts.filter((c) => !c.same).length,
      duplicates: conflicts.filter((c) => c.same).length,
    },
  };
}

// ─── 迁移目标 ───────────────────────────────────────────────────────

// 把 to/platform 归一成目标列表 [{platform, platformName, scope, dir}]
// to 接受 global（= user）/ project / all；platform 接受 id 或别名（claude / workbuddy / cursor…）
async function resolveTargets({ to, platform, project } = {}) {
  const s = await getSettings();
  // 项目根缺省取「启动目录」（serve <dir> / cwd，或面板回传的 x-nx-rh-scope）
  const projRoot = project || projectRoot();
  const toId = to === 'global' ? 'user' : to;
  const scopes = toId && toId !== 'all' ? [toId] : SCOPE_IDS;
  for (const sc of scopes) {
    if (!SCOPE_IDS.includes(sc)) {
      throw badInput('to 只能是 user | global | project | all，收到: ' + to);
    }
  }
  let platformIds;
  if (platform && platform !== 'all') {
    const a = adapterById(platform);
    if (!a) throw badInput(`未知平台: ${platform}（可用: ${platformNames().join(' / ')}，或别名 claude / wb）`);
    platformIds = [a.id];
  } else {
    platformIds = s.platforms.length ? s.platforms : ['claude-code'];
  }
  const list = [];
  for (const sc of scopes) {
    for (const pid of platformIds) {
      const a = adapterById(pid);
      if (!a) throw badInput('未知平台: ' + pid);
      const dir = targetDirFor(a.id, sc, projRoot);
      list.push({ platform: a.id, platformName: a.name, scope: sc, dir });
    }
  }
  return list;
}

// 扫描目标目录，返回该目录下的所有 skill（含形态）
async function scanTargetDir(dir, { platform, scope }) {
  const skills = await scanSkillsRoot(dir);
  for (const s of skills) {
    s.platform = platform;
    s.scope = scope;
  }
  return skills;
}

// ─── 批量选择（--all / --include / --exclude / --match） ─────────────
//
// 为什么值得一组：全量迁移时「手点 N 次」既慢又容易漏；而「全都要，除了某几个」
// 才是真实需求。--exclude 因此是一等参数，不是边角料。

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
function nameList(v) {
  if (!v) return [];
  return (Array.isArray(v) ? v : [v]).map((x) => String(x).trim()).filter(Boolean);
}

function applyFilters(list, { include, exclude, match } = {}) {
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

// 撤销/提交的候选池来自**目标目录的扫描**（含未入 Hub 的游离 skill）
async function collectTargetSkills({ project }) {
  const scan = await listAllSkills({ project });
  const map = new Map();
  for (const x of scan.skills) map.set(x.name, x.description || '');
  for (const x of scan.orphans) map.set(x.name, x.description || '');
  return [...map].map(([name, description]) => ({ name, description }));
}

// ─── 列表 / 详情 ────────────────────────────────────────────────────

// 来源级问题：目录不存在 / 空源 / 嵌套订阅 / 同一根重复订阅。
// 订阅源是唯一可信源，这些问题都属于**订阅配置**该修的，不是 skill 该修的。
function hubProblemsFor(sources) {
  const problems = [];
  for (const src of sources) {
    if (!src.exists) problems.push({ kind: 'missing', path: src.path, reason: '目录不存在' });
    else if (!src.count) {
      problems.push({
        kind: 'empty',
        path: src.path,
        reason: '没有实文件 skill（空目录，或里面全是链接——链接是别处的落地副本，不算来源）',
      });
    }
  }
  const keys = sources.map((s) => ({ path: s.path, key: cwdScope(s.root) }));
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = keys[i];
      const b = keys[j];
      if (a.key === b.key) {
        problems.push({ kind: 'same-root', path: b.path, reason: `与 ${a.path} 解析到同一个 skills 根（重复订阅）` });
      } else if (b.key.startsWith(a.key + sep)) {
        problems.push({ kind: 'nested', path: b.path, reason: `位于 ${a.path} 之内（嵌套订阅，会重复计数）` });
      } else if (a.key.startsWith(b.key + sep)) {
        problems.push({ kind: 'nested', path: a.path, reason: `位于 ${b.path} 之内（嵌套订阅，会重复计数）` });
      }
    }
  }
  return problems;
}

// 每行 = 一个订阅源 skill（**只统计实文件**），带各目标迁移状态与跨源冲突。
//
// platform（可选）：只看某一个平台（即使它不在「启用平台」范围里也照样扫描），
// 供 Skill 三级结构里的「平台子页」使用；不传则按启用平台。
export async function listAllSkills({ project, source, platform } = {}) {
  const s = await getSettings();
  const { current, sources } = await listSources();
  const chosen = source ? sources.find((x) => resolve(x.path).toLowerCase() === resolve(source).toLowerCase()) : null;

  const scanned = [];
  for (const src of sources) {
    if (chosen && src.path !== chosen.path) continue;
    if (!src.exists) continue;
    scanned.push(...(await scanSkillsRoot(src.root, { source: src.path, realOnly: true })));
  }

  // 跨源聚合：同名 = 冲突候选。内容一致是「重复订阅」（无害但建议清理），
  // 内容不同才是真冲突——两个真相源打架，必须先解决再迁移。
  const byName = new Map();
  for (const sk of scanned) {
    const e = byName.get(sk.name) || {
      name: sk.name,
      description: sk.description,
      dir: sk.dir,
      md5: sk.md5,
      lastModified: sk.lastModified,
      source: sk.source,
      sources: [],
    };
    e.sources.push({ path: sk.source, dir: sk.dir, md5: sk.md5 });
    if (sk.source === current) {
      e.source = sk.source;
      e.dir = sk.dir;
      e.md5 = sk.md5;
      e.description = sk.description;
    }
    byName.set(sk.name, e);
  }
  const conflicts = [];
  for (const e of byName.values()) {
    if (e.sources.length < 2) continue;
    const same = e.sources.every((x) => x.md5 === e.sources[0].md5);
    conflicts.push({ name: e.name, kind: same ? 'duplicate' : 'conflict', same, sources: e.sources });
  }
  conflicts.sort((a, b) => a.name.localeCompare(b.name));

  const targets = await resolveTargets({ to: 'all', project, platform: platform || undefined });
  const rows = [];
  for (const sk of [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const cells = [];
    for (const t of targets) {
      const p = join(t.dir, sk.name);
      const on = await pathExists(p);
      cells.push({
        platform: t.platform,
        platformName: t.platformName,
        scope: t.scope,
        dir: p,
        on,
        linkType: on ? await detectLinkType(p) : '',
      });
    }
    const conflict = conflicts.find((c) => c.name === sk.name) || null;
    rows.push({ ...sk, cells, current: sk.source === current, conflict });
  }

  // 目标目录里存在、但订阅源没有的 skill —— 待「提交到 Hub」
  const sourceNames = new Set(rows.map((r) => r.name));
  const orphanMap = new Map();
  for (const t of targets) {
    for (const sk of await scanTargetDir(t.dir, t)) {
      if (sourceNames.has(sk.name)) continue;
      const e = orphanMap.get(sk.name) || {
        name: sk.name,
        description: sk.description,
        md5: sk.md5,
        cells: [],
      };
      e.cells.push({
        platform: t.platform,
        platformName: t.platformName,
        scope: t.scope,
        dir: join(t.dir, sk.name),
        on: true,
        linkType: sk.linkType,
      });
      orphanMap.set(sk.name, e);
    }
  }

  // 全平台汇总（总览页用）：扫描每个适配器的用户级 / 项目级目录，
  // 按「是否在订阅源」分 managed / orphan，按形态分 links / copies。
  // 一次请求拿全 11 个平台，避免前端逐个平台探测。
  const projRoot = project || projectRoot();
  const platformSummary = [];
  const projNames = new Set();
  for (const a of ADAPTERS) {
    const rec = {
      id: a.id, name: a.name,
      enabled: s.platforms.includes(a.id), isDefault: s.defaultPlatform === a.id,
      managed: 0, orphan: 0, copies: 0, links: 0, user: 0, project: 0,
    };
    for (const sc of SCOPE_IDS) {
      const dir = targetDirFor(a.id, sc, projRoot);
      const found = await scanSkillsRoot(dir);
      if (found.length) rec[sc] = found.length;
      if (sc === 'project') for (const x of found) projNames.add(x.name);
      for (const x of found) {
        if (sourceNames.has(x.name)) rec.managed += 1;
        else rec.orphan += 1;
        if (x.linkType) rec.links += 1;
        else rec.copies += 1;
      }
    }
    platformSummary.push(rec);
  }

  return {
    hub: { path: current, ...(await hubInfo()) },
    settings: { platforms: s.platforms, defaultPlatform: s.defaultPlatform, syncMode: s.skillSyncMode },
    sources,
    hubProblems: hubProblemsFor(sources),
    conflicts,
    skills: rows,
    orphans: [...orphanMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
    platformSummary,
    // 当前项目目录（cwd 作用域）里实际存在的 skill：总览页「当前项目」入口的数据源
    projectSummary: {
      root: projRoot,
      count: projNames.size,
      orphan: [...projNames].filter((n) => !sourceNames.has(n)).length,
    },
  };
}

// ─── 当前项目目录里的 skill ─────────────────────────────────────────
//
// 扫**全部**适配器的项目级目录，不只启用的平台——「项目里物理上有什么」
// 不该被启用范围裁剪；未启用平台只标 enabled=false，照常列出。
// 每个 skill 标注 inHub（是否已在订阅源），为「收进订阅源」提供候选集。
export async function listProjectSkills({ project } = {}) {
  const s = await getSettings();
  const projRoot = project || projectRoot();
  const sourceNames = new Set((await listAllSourceSkills()).map((x) => x.name));
  const dirs = [];
  const byName = new Map();
  for (const a of ADAPTERS) {
    const dir = targetDirFor(a.id, 'project', projRoot);
    const found = await scanSkillsRoot(dir);
    if (!found.length && !(await pathExists(dir))) continue;
    dirs.push({
      platform: a.id,
      platformName: a.name,
      dir,
      enabled: s.platforms.includes(a.id),
      isDefault: s.defaultPlatform === a.id,
      skills: found.map((x) => ({ ...x, inHub: sourceNames.has(x.name) })),
    });
    for (const sk of found) {
      const e = byName.get(sk.name) || {
        name: sk.name,
        description: sk.description,
        inHub: sourceNames.has(sk.name),
        cells: [],
      };
      e.cells.push({
        platform: a.id,
        platformName: a.name,
        dir: sk.dir,
        linkType: sk.linkType,
        enabled: s.platforms.includes(a.id),
      });
      byName.set(sk.name, e);
    }
  }
  return {
    projectRoot: projRoot,
    dirs,
    skills: [...byName.values()].sort((x, y) => x.name.localeCompare(y.name)),
  };
}

// ─── 解析一个 skill 的「可读目录」 ──────────────────────────────────
//
// 优先级：当前主源 → 其它订阅源 → 平台目录里的落点。
// **链接照读**：读链接读到的就是它目标的内容——「这个游离链接到底是什么」的答案
// 就在这里。只有断链（目标已被删）才读不到，那时如实标 broken，而不是装作不存在
// （本机实测：42 个未入 Hub 的 skill 全是链接，其中就有指向已删除目录的）。
export async function resolveSkillDir({ name, project } = {}) {
  name = assertSafeName(name);
  const entries = await sourceEntriesFor(name);
  if (entries.length) {
    const [hit, ...rest] = entries;
    return {
      name,
      dir: hit.dir,
      origin: 'source',
      source: hit.source,
      alsoIn: rest.map((e) => e.source),
      broken: false,
      linkType: '',
      linkTarget: '',
    };
  }
  let dead = null;
  for (const t of await resolveTargets({ to: 'all', project })) {
    const p = join(t.dir, name);
    if (!(await pathExists(p))) continue; // lstat：悬空链接也算存在
    const linkType = await detectLinkType(p);
    const place = {
      name,
      dir: p,
      origin: linkType ? 'link' : 'target',
      source: '',
      platform: t.platform,
      platformName: t.platformName,
      scope: t.scope,
      linkType,
      linkTarget: linkType ? await fsp.readlink(p).catch(() => '') : '',
      broken: false,
      alsoIn: [],
    };
    // exists 走 access（跟随链接）：能读才叫可读，读不到就是断链
    if (await exists(join(p, 'SKILL.md'))) return place;
    place.broken = true;
    if (!dead) dead = place;
  }
  if (dead) return dead; // 全是断链：返回它，让上层说明「链接已失效」
  throw notFound(`未找到 skill: ${name}（订阅源与各平台目录里都没有）`);
}

// 一个 skill 目录下的文件清单（相对路径）。
// 跳过噪音目录、**不跟随**目录内的链接——跟随会把别处整棵树读进来。
const SKIP_DIRS = new Set(['.git', 'node_modules', '.turbo', 'dist', '.next', '__pycache__', '.venv']);
const FILE_LIST_MAX = 500;

async function listSkillFiles(root) {
  const out = [];
  async function walk(dir, prefix) {
    if (out.length >= FILE_LIST_MAX) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= FILE_LIST_MAX) return;
      if (e.isSymbolicLink() || SKIP_DIRS.has(e.name)) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) { await walk(join(dir, e.name), rel); continue; }
      if (!e.isFile()) continue;
      const st = await fsp.stat(join(dir, e.name)).catch(() => null);
      out.push({ path: rel, bytes: st ? st.size : 0 });
    }
  }
  await walk(root, '');
  // SKILL.md 永远排第一：它是入口，其余文件都是它的附属。
  // 比较**不区分大小写**——Windows 上确实存在写成 skill.md 的 skill（实测遇到过一个），
  // 那边文件系统不区分大小写所以照样能读，但排序按字面比就会把它排到 references/ 后面。
  out.sort((a, b) => {
    const am = a.path.toLowerCase() === 'skill.md';
    const bm = b.path.toLowerCase() === 'skill.md';
    if (am !== bm) return am ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
  return out;
}

// 单个 skill 的详情（来源 + 完整描述 + 落点形态 + **文件清单**）
export async function skillInfo({ name, project } = {}) {
  name = assertSafeName(name);
  const found = await findSourceSkill(name);
  const targets = await resolveTargets({ to: 'all', project });
  const cells = [];
  for (const t of targets) {
    const p = join(t.dir, name);
    const on = await pathExists(p);
    cells.push({
      platform: t.platform,
      platformName: t.platformName,
      scope: t.scope,
      dir: p,
      on,
      linkType: on ? await detectLinkType(p) : '',
    });
  }
  if (!found && !cells.some((c) => c.on)) throw notFound('未找到 skill: ' + name);

  // 内容从哪读：订阅源优先，否则退到平台目录里的落点（链接照读）。断链没有内容，
  // 但要如实标出来——对未入 Hub 的 skill 来说，那正是用户最需要知道的一件事。
  const place = await resolveSkillDir({ name, project }).catch(() => null);
  const dir = place?.dir || '';
  const broken = !!place?.broken;
  const raw = dir && !broken ? await fsp.readFile(join(dir, 'SKILL.md'), 'utf8').catch(() => '') : '';
  const outline = mdOutline(raw, 3);
  const local = dir && !found && !broken ? await readSkill(dir) : null;
  // 跨源冲突（只看订阅源之间；目的仓库直接被覆盖，不参与冲突检测）
  const entries = await sourceEntriesFor(name);
  const conflict = entries.length > 1
    ? {
        same: entries.every((e) => e.md5 === entries[0].md5),
        sources: entries.map((e) => ({ path: e.source, dir: e.dir, md5: e.md5 })),
      }
    : null;
  return {
    name,
    description: found ? found.description : (local?.description || '(无描述)'),
    source: found ? found.source : '',
    origin: place?.origin || '',
    dir: broken ? place.dir : dir,
    linkTarget: place?.linkTarget || '',
    broken,
    alsoIn: found ? found.alsoIn || [] : [],
    md5: found ? found.md5 : (local?.md5 || ''),
    conflict,
    outline,
    stats: mdStats(raw, outline),
    files: dir && !broken ? await listSkillFiles(dir) : [],
    cells,
  };
}

// `skill cat`：把 SKILL.md（或某个 reference）全文交给外部 agent，
// 让它在自己环境里也能获得完整上下文。ref 为空时取 SKILL.md。
// **未入 Hub 的 skill 同样读得到**（落到平台目录里的落点，链接照读）——
// 面板的「完整查看」对它就靠这条；以前这里只查订阅源，点进去必然 NOT_FOUND。
export async function skillContent({ name, ref, project } = {}) {
  const place = await resolveSkillDir({ name, project });
  if (place.broken) {
    throw notFound(
      `skill ${name} 的落点是断链：${place.dir}${place.linkTarget ? ` → ${place.linkTarget}` : ''}（目标已不存在）`
    );
  }
  const file = ref ? assertSafeRelPath(ref, { label: 'ref 路径' }) : 'SKILL.md';
  const abs = join(place.dir, file);
  const content = await fsp.readFile(abs, 'utf8').catch(() => null);
  if (content === null) throw notFound(`skill ${name} 里没有文件: ${file}`);
  const outline = mdOutline(content, 3);
  return {
    skillName: name,
    source: place.source,
    origin: place.origin,
    dir: place.dir,
    linkType: place.linkType || '',
    ref: file,
    content,
    contentBytes: Buffer.byteLength(content, 'utf8'),
    outline,
    stats: mdStats(content, outline),
  };
}

// ─── skill 实体的增改删（只动订阅源里那份实文件） ────────────────────
//
// 读（R）由 show / cat 承担；迁移覆盖目标副本，所以这里不需要「同步到目标」。
// 刻意不声明 resource: 'skill'——`skill get` 这个 CLI 已被内置手册占用（bundled 模块），
// CRUD 断言要求的 get 动词没法按 A00 命名；不改名就不硬凑。

// 组装 SKILL.md：frontmatter（name/description）+ 正文
function buildSkillMd(name, description, body) {
  const desc = String(description || '').replace(/\r?\n/g, ' ').trim() || `${name} 的说明`;
  const text = String(body || '').replace(/^\s*/, '');
  return `---\nname: ${name}\ndescription: ${desc}\n---\n\n${text}${text.endsWith('\n') ? '' : '\n'}`;
}

// 新建：订阅源里已存在同名 → CONFLICT（A00：不要静默 upsert）。
// content 可以是「只有正文」（自动补 frontmatter）或完整的 SKILL.md（--- 开头，校验 frontmatter）。
export async function addSkill({ name, description, content } = {}) {
  name = assertSafeName(name);
  const hub = await requireHubPath();
  const root = await resolveSkillsRoot(hub);
  const dir = join(root, name);
  if (await exists(dir)) throw conflict('订阅源里已存在同名 skill: ' + dir);
  const raw = typeof content === 'string' ? content.trim() : '';
  let md;
  if (raw.startsWith('---')) {
    const fm = parseFrontmatter(raw + (raw.endsWith('\n') ? '' : '\n'));
    if (!fm.name || !fm.description) throw badInput('SKILL.md 需要含 name 与 description 的 frontmatter');
    if (fm.name !== name) throw badInput(`frontmatter 的 name（${fm.name}）必须与目录名一致: ${name}`);
    md = raw + '\n';
  } else {
    md = buildSkillMd(name, description, raw);
  }
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(join(dir, 'SKILL.md'), md, 'utf8');
  return { status: 'ok', name, dir, path: join(dir, 'SKILL.md') };
}

// 改写：PATCH 语义——这里改的是 SKILL.md 全文；frontmatter 必须可解析且 name 与目录名一致
export async function updateSkill({ name, content } = {}) {
  name = assertSafeName(name);
  const entries = await sourceEntriesFor(name);
  const current = await hubPath();
  const found = entries.find((e) => e.source === current) || entries[0];
  if (!found) throw notFound('订阅源里没有该 skill: ' + name);
  const text = String(content ?? '');
  const fm = parseFrontmatter(text);
  if (!fm.name || !fm.description) {
    throw badInput('SKILL.md 需要含 name 与 description 的 frontmatter（保留开头三行）');
  }
  if (fm.name !== name) {
    throw badInput(`frontmatter 的 name（${fm.name}）必须与目录名一致: ${name}`);
  }
  await fsp.writeFile(join(found.dir, 'SKILL.md'), text, 'utf8');
  return { status: 'ok', name, dir: found.dir, source: found.source };
}

// 删除：目标侧还有副本/链接时先 blocked（删了会悬空），--force 才继续
export async function removeSkill({ name, force, project } = {}) {
  name = assertSafeName(name);
  const entries = await sourceEntriesFor(name);
  const current = await hubPath();
  const found = entries.find((e) => e.source === current) || entries[0];
  if (!found) throw notFound('订阅源里没有该 skill: ' + name);

  const targets = await resolveTargets({ to: 'all', project });
  const refs = [];
  for (const t of targets) {
    const p = join(t.dir, name);
    if (await pathExists(p)) {
      refs.push({
        platform: t.platform,
        platformName: t.platformName,
        scope: t.scope,
        path: p,
        linkType: await detectLinkType(p),
      });
    }
  }
  if (refs.length && !force) {
    return {
      status: 'blocked',
      name,
      refs,
      reason: `${refs.length} 个目标还引用着它，删除会让链接悬空`,
    };
  }
  await fsp.rm(found.dir, { recursive: true, force: true });
  return { status: 'ok', name, removed: found.dir, dangling: refs };
}

// 彻底删除一个 skill：**所有平台落点 + 订阅源里的实文件**。
//
// 与 skill remove 的分工：remove 只动订阅源那份（目标侧还引用就 blocked），
// 用来「下架，但保留各平台落点」；purge 是「这个名字不该存在了」。两件事分开，
// 因为后果不同，而且**未入 Hub 的 skill 只有 purge 这一条路**（订阅源里根本没有它，
// remove 对它只会 NOT_FOUND）。
//
// 实体副本仍要 --force：它可能含本地改动、删了不可逆；链接没有这个问题。
export async function purgeSkill({ name, project, force, dryRun } = {}) {
  name = assertSafeName(name);

  const entries = await sourceEntriesFor(name);
  const sources = entries.map((e) => ({ source: e.source, dir: e.dir }));
  const targets = [];
  for (const t of await resolveTargets({ to: 'all', project })) {
    const p = join(t.dir, name);
    if (!(await pathExists(p))) continue;
    targets.push({
      platform: t.platform,
      platformName: t.platformName,
      scope: t.scope,
      path: p,
      linkType: await detectLinkType(p),
    });
  }
  if (!sources.length && !targets.length) {
    throw notFound(`未找到 skill: ${name}（订阅源与各平台目录里都没有）`);
  }

  const plan = { name, sources, targets, copies: targets.filter((c) => !c.linkType).length };
  if (dryRun) return { status: 'ok', dryRun: true, name, plan, removed: [] };

  if (plan.copies && !force) {
    return {
      status: 'blocked',
      dryRun: false,
      name,
      plan,
      removed: [],
      reason: `${plan.copies} 处是实体副本（可能含本地改动），删除不可逆，加 --force 确认`,
    };
  }

  const removed = [];
  // 先删落点再删订阅源：反过来的话，链接会先悬空，再删链接时读到的形态已经不对
  for (const c of targets) {
    await fsp.rm(c.path, { recursive: true, force: true });
    removed.push({ kind: 'target', ...c });
  }
  for (const s of sources) {
    await fsp.rm(s.dir, { recursive: true, force: true });
    removed.push({ kind: 'source', path: s.dir, source: s.source });
  }
  return { status: 'ok', dryRun: false, name, plan, removed };
}

// ─── 迁移（source → target） ────────────────────────────────────────

// 把 srcDir 落到一个目标：已指向同一实体则跳过；**其余一律直接覆盖**。
// 目的仓库不参与冲突检测——它只是落地副本，订阅源里永远有一份，覆盖可恢复；
// 真正需要冲突检测的是**订阅源之间**（见 sourceAudit）。
// dryRun=true 时只判定不落盘——批量操作前先预演是刚需。
async function placeAt(srcDir, name, target, mode, dryRun) {
  const dst = join(target.dir, name);
  const base = { ...target, path: dst };
  const lt = await detectLinkType(dst);
  if (lt) {
    const t = await fsp.readlink(dst).catch(() => null);
    if (t) {
      const absT = isAbsolute(t) ? t : resolve(dirname(dst), t);
      if (await sameRealPath(absT, srcDir)) {
        return { ...base, status: 'ok', skipped: true, linkType: lt };
      }
    }
  }
  const existed = await exists(dst);
  if (dryRun) {
    return existed
      ? { ...base, status: 'ok', mode, wouldReplace: true }
      : { ...base, status: 'ok', mode, wouldCreate: true };
  }

  if (mode === 'symlink') {
    const r = await createSkillLink(srcDir, dst);
    if (r.ok) {
      return { ...base, status: 'ok', mode: 'symlink', linkType: r.linkType, already: r.already };
    }
    // 链接失败 → 降级复制，迁移不因权限中断
    if (await exists(dst)) await fsp.rm(dst, { recursive: true, force: true });
    await fsp.cp(srcDir, dst, { recursive: true, dereference: true, force: true });
    return { ...base, status: 'ok', mode: 'copy', degraded: true, degradedReason: r.error };
  }
  if (await exists(dst)) await fsp.rm(dst, { recursive: true, force: true });
  await fsp.mkdir(dirname(dst), { recursive: true });
  await fsp.cp(srcDir, dst, { recursive: true, dereference: true, force: true });
  return { ...base, status: 'ok', mode: 'copy' };
}

// 迁移 skill 到目标集。选择方式：<name...> / --all / --include，再叠加 --exclude / --match。
// 目的仓库不做冲突检测（直接覆盖）；跨**订阅源**的冲突会 blocked，可用 --source 指定用哪一份。
export async function migrateSkill({
  name, names, all, include, exclude, match,
  to, platform, mode, project, source, dryRun,
} = {}) {
  const s = await getSettings();
  const m = mode === 'copy' || mode === 'symlink' ? mode : s.skillSyncMode;
  const targets = await resolveTargets({ to, platform, project });
  const list = await selectSourceSkills({ names: names ?? name, all, include, exclude, match });

  const results = [];
  const blocked = [];
  for (const sk of list) {
    // 跨源冲突：同名实文件出现在多个订阅源且内容不同。
    // 目的仓库可以直接覆盖，但**用哪份内容覆盖**必须先定——这是来源侧的冲突。
    const entries = await sourceEntriesFor(sk.name);
    let src = sk;
    if (entries.length > 1 && entries.some((e) => e.md5 !== entries[0].md5)) {
      const pick = source ? entries.find((e) => samePath(e.source, resolve(String(source)))) : null;
      if (source && !pick) {
        throw badInput(`--source 指定的订阅源里没有 ${sk.name}: ${source}`);
      }
      if (!pick) {
        for (const t of targets) {
          blocked.push({
            name: sk.name,
            platform: t.platform,
            platformName: t.platformName,
            scope: t.scope,
            dir: join(t.dir, sk.name),
            status: 'blocked',
            reason: '同名 skill 在多个订阅源且内容不同',
            sources: entries.map((e) => ({ source: e.source, md5: e.md5 })),
          });
        }
        continue;
      }
      src = pick;
    }
    for (const t of targets) {
      results.push({ name: sk.name, ...(await placeAt(src.dir, sk.name, t, m, dryRun)) });
    }
  }
  return {
    status: blocked.length ? 'blocked' : 'ok',
    dryRun: !!dryRun,
    mode: m,
    selected: list.map((x) => x.name),
    count: results.length,
    migrated: results.filter((r) => r.status === 'ok' && !r.skipped && !dryRun).length,
    wouldChange: results.filter((r) => r.status === 'ok' && !r.skipped).length,
    skipped: results.filter((r) => r.skipped).length,
    blocked,
    results,
  };
}

// 撤销迁移（target 侧移除）。候选来自目标扫描，因此**也能清掉未入 Hub 的游离 skill**。
export async function unmigrateSkill({
  name, names, all, include, exclude, match,
  to, platform, project, force, dryRun,
} = {}) {
  const targets = await resolveTargets({ to, platform, project });
  const wanted = nameList(names ?? name);

  let base;
  if (wanted.length) {
    base = wanted.map((n) => ({ name: n, description: '' }));
  } else if (all || (include && include.length)) {
    base = await collectTargetSkills({ project });
  } else {
    throw badInput('需要 <name...>、--all 或 --include <模式> 之一');
  }
  const list = applyFilters(base, { include, exclude, match });
  if (!list.length) throw notFound('按当前筛选条件没有匹配的 skill');

  const removed = [];
  const needForce = [];
  const plan = [];
  for (const { name: n } of list) {
    for (const t of targets) {
      const dst = join(t.dir, n);
      if (!(await pathExists(dst))) continue;
      const lt = await detectLinkType(dst);
      const entry = { name: n, platform: t.platform, platformName: t.platformName, scope: t.scope, path: dst, linkType: lt };
      if (dryRun) {
        plan.push(entry);
        continue;
      }
      if (!lt && !force) {
        needForce.push(entry);
        continue;
      }
      await fsp.rm(dst, { recursive: true, force: true });
      removed.push(entry);
    }
  }
  if (dryRun) {
    return { status: 'ok', dryRun: true, selected: list.map((x) => x.name), removed: [], plan, needForce: [], missing: [] };
  }
  // 四个取值（A00 §八）：ok / skipped / conflict / blocked。
  // 「实体副本要 --force」属于 blocked——操作合法，但被规则挡住，先满足前置条件。
  if (needForce.length && !removed.length) {
    return {
      status: 'blocked',
      dryRun: false,
      selected: list.map((x) => x.name),
      removed,
      needForce,
      reason: `${needForce.length} 处是实体副本（可能含本地改动），删除不可逆，加 --force 确认`,
      missing: [],
    };
  }
  return { status: 'ok', dryRun: false, selected: list.map((x) => x.name), removed, needForce, missing: [] };
}

// 链接 → 实体（物化），使该目标不再随订阅源实时变化
export async function materializeSkill({ name, to, platform, project } = {}) {
  name = assertSafeName(name);
  const targets = await resolveTargets({ to, platform, project });
  const done = [];
  for (const t of targets) {
    const dst = join(t.dir, name);
    if (!(await pathExists(dst))) continue;
    const lt = await detectLinkType(dst);
    if (!lt) continue;
    const target = await fsp.readlink(dst);
    const absT = isAbsolute(target) ? target : resolve(dirname(dst), target);
    await fsp.rm(dst, { force: true });
    await fsp.cp(absT, dst, { recursive: true, dereference: true, force: true });
    done.push({ platform: t.platform, scope: t.scope, path: dst, source: absT });
  }
  return { converted: done.length > 0, results: done };
}

// ─── 提交（target → source） ────────────────────────────────────────
// 把平台目录里的实体 skill 收进当前订阅源，然后**删除目标的实文件**、
// 改回指向订阅源的链接 —— 收敛「唯一实文件 = 订阅源」这条规范。

async function submitOne(name, { targets, hubRoot, force, keepTarget, dryRun }) {
  name = assertSafeName(name);

  // 优先挑「实体」形态的来源（链接没什么可提交的）
  let picked = null;
  for (const t of targets) {
    const dst = join(t.dir, name);
    if (!(await pathExists(dst))) continue;
    const lt = await detectLinkType(dst);
    if (!picked || (!lt && picked.linkType)) picked = { ...t, path: dst, linkType: lt };
  }
  if (!picked) return { status: 'missing', name, reason: '目标目录里没有该 skill' };
  if (picked.linkType) {
    return { status: 'skipped', name, reason: '目标已是链接（本就指向某个源），无需提交', target: picked.path };
  }

  const dst = join(hubRoot, name);
  if (await exists(dst)) {
    const files = await diffTrees(picked.path, dst);
    if (files.length && !force) {
      return { status: 'conflict', name, files, path: dst, target: picked.path };
    }
  }
  if (dryRun) {
    return { status: 'ok', name, dryRun: true, sourceDir: dst, target: picked.path, wouldRelink: !keepTarget };
  }

  if (await exists(dst)) await fsp.rm(dst, { recursive: true, force: true });
  await fsp.mkdir(dirname(dst), { recursive: true });
  await fsp.cp(picked.path, dst, { recursive: true, dereference: true, force: true });

  // 删除目标实文件；默认改回软链接，保持项目可用（keepTarget=true 则只删不建链）
  let relinked = null;
  if (!keepTarget) {
    await fsp.rm(picked.path, { recursive: true, force: true });
    const r = await createSkillLink(dst, picked.path);
    relinked = r.ok ? r.linkType || 'symlink' : null;
    if (!r.ok) {
      // 建链失败时至少恢复一份副本，不能让项目凭空丢 skill
      await fsp.cp(dst, picked.path, { recursive: true, dereference: true, force: true });
    }
  }
  return { status: 'ok', name, sourceDir: dst, target: picked.path, relinked, keepTarget: !!keepTarget };
}

// 提交：<name...> 点名；或 --all / --include 取「未入 Hub」那一批（--exclude 排掉个别）。
// into：收进**哪个**订阅源（须已订阅；缺省当前主源）。与 migrate 的 --source 刻意区分——
// source = 用哪个源的内容（来源侧冲突），into = 落到哪个源（提交方向）。
export async function submitSkill({
  name, names, all, include, exclude, match,
  to, platform, project, force, keepTarget, dryRun, into,
} = {}) {
  const { sources } = await listSources();
  let hub;
  if (into) {
    const hit = sources.find((x) => samePath(x.path, resolve(String(into))));
    if (!hit) {
      throw badInput(`--into 不是已订阅的订阅源: ${into}（已订阅: ${sources.map((x) => x.path).join(' , ') || '无'}）`);
    }
    if (!hit.exists) throw notFound('--into 指定的订阅源目录不存在: ' + hit.path);
    hub = hit.path;
  } else {
    hub = await requireHubPath();
  }
  const targets = await resolveTargets({ to, platform, project });
  const hubRoot = await resolveSkillsRoot(hub);
  const wanted = nameList(names ?? name);

  let list;
  if (wanted.length) {
    list = wanted.map((n) => ({ name: n, description: '' }));
  } else if (all || (include && include.length)) {
    const scan = await listAllSkills({ project });
    list = scan.orphans.map((o) => ({ name: o.name, description: o.description || '' }));
  } else {
    throw badInput('需要 <name...>、--all 或 --include <模式> 之一');
  }
  const chosen = applyFilters(list, { include, exclude, match });
  if (!chosen.length) throw notFound('按当前筛选条件没有可提交的 skill（都已入 Hub？）');

  const results = [];
  for (const { name: n } of chosen) {
    results.push(await submitOne(n, { targets, hubRoot, force, keepTarget, dryRun }));
  }
  const conflicts = results.filter((r) => r.status === 'conflict');
  return {
    status: conflicts.length ? 'conflict' : 'ok',
    dryRun: !!dryRun,
    selected: chosen.map((x) => x.name),
    into: hub,
    count: results.length,
    submitted: results.filter((r) => r.status === 'ok' && !r.dryRun).length,
    wouldSubmit: results.filter((r) => r.status === 'ok').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    missing: results.filter((r) => r.status === 'missing').length,
    conflicts,
    results,
  };
}

// 适配器总表：带上**解析后的绝对落点**，这样「把一个 skill 变成 .claude / .workbuddy / .cursor」
// 在 CLI 上就是可读、可抄的——不必先起面板再猜目录。
export async function adaptersInfo({ project } = {}) {
  const s = await getSettings();
  const projRoot = project || projectRoot();
  return ADAPTERS.map((a) => ({
    ...a,
    enabled: s.platforms.includes(a.id),
    isDefault: s.defaultPlatform === a.id,
    userDir: targetDirFor(a.id, 'user'),
    projectDir: targetDirFor(a.id, 'project', projRoot),
  }));
}
