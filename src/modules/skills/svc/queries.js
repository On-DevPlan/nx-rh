// 列表 / 详情 / 内容读取：面板与 `skill hub list|show|cat` 的数据面。
// 依赖 scan（读目录）、sources（订阅源真相）、targets（平台 × 作用域归一）。
import { join, resolve } from 'node:path';
import fsp from 'node:fs/promises';
import { exists, pathExists } from '../../../core/fstree.js';
import { detectLinkType } from '../../../core/link.js';
import { sep } from 'node:path';
import { assertSafeName, assertSafeRelPath, projectRoot, cwdScope } from '../../../core/paths.js';
import { notFound } from '../../../core/errors.js';
import { mdOutline, mdStats } from '../../../core/mdoutline.js';
import { getSettings } from '../../settings/service.js';
import { scanSkillsRoot, readSkill } from './scan.js';
import { listSources, hubInfo, listAllSourceSkills, sourceEntriesFor, findSourceSkill } from './sources.js';
import { resolveTargets, scanTargetDir, SCOPE_IDS } from './targets.js';
import { ADAPTERS, targetDirFor } from '../adapters.js';

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
// 优先级：当前主源 → 其它订阅源 → 平台目录里的安装位置。
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

// 单个 skill 的详情（来源 + 完整描述 + 安装位置形态 + **文件清单**）
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

  // 内容从哪读：订阅源优先，否则退到平台目录里的安装位置（链接照读）。断链没有内容，
  // 但要如实标出来——对不在订阅源的 skill 来说，那正是用户最需要知道的一件事。
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
// **不在订阅源的 skill 同样读得到**（落到平台目录里的安装位置，链接照读）——
// 面板的「完整查看」对它就靠这条；以前这里只查订阅源，点进去必然 NOT_FOUND。
export async function skillContent({ name, ref, project } = {}) {
  const place = await resolveSkillDir({ name, project });
  if (place.broken) {
    throw notFound(
      `skill ${name} 的安装位置是断链：${place.dir}${place.linkTarget ? ` → ${place.linkTarget}` : ''}（目标已不存在）`
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
