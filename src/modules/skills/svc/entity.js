// skill 实体的增改删（只动订阅源里那份实文件）。
//
// 读（R）由 queries 的 skillInfo / skillContent 承担；迁移覆盖目标副本，
// 所以这里不需要「同步到目标」。
// 刻意不声明 resource: 'skill'——`skill get` 这个 CLI 已被内置手册占用（bundled 模块），
// CRUD 断言要求的 get 动词没法按 A00 命名；不改名就不硬凑。
import { join, resolve } from 'node:path';
import fsp from 'node:fs/promises';
import { exists, pathExists } from '../../../core/fstree.js';
import { parseFrontmatter } from '../../../core/frontmatter.js';
import { assertSafeName } from '../../../core/paths.js';
import { badInput, notFound, conflict } from '../../../core/errors.js';
import { detectLinkType, samePath, sameRealPath, createSkillLink } from '../../../core/link.js';
import { hubPath, requireHubPath } from '../../settings/service.js';
import { resolveSkillsRoot } from './scan.js';
import { sourceEntriesFor } from './sources.js';
import { resolveTargets } from './targets.js';
import { sourceAudit } from './queries.js';

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

// 彻底删除一个 skill：**所有平台安装位置 + 订阅源里的实文件**。
//
// 与 skill remove 的分工：remove 只动订阅源那份（目标侧还引用就 blocked），
// 用来「下架，但保留各平台安装位置」；purge 是「这个名字不该存在了」。两件事分开，
// 因为后果不同，而且**不在订阅源的 skill 只有 purge 这一条路**（订阅源里根本没有它，
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
  // 先删安装位置再删订阅源：反过来的话，链接会先悬空，再删链接时读到的形态已经不对
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

// 唯一化一个跨源重复/冲突的 skill：以 --source 那份实文件为准，处理其余来源的实文件。
//   as=link   → 其余转为指向准份的链接：来源目录里仍能看到这个 skill，但链接不算来源
//               （见 scan 的 realOnly），冲突与重复随之消失——「勋章」形态：一份实文件 + N 处链接
//   as=delete → 其余实文件直接删除：最彻底的唯一实文件，其余来源里这个 skill 不复存在
// 选哪份为准是**内容决策**（哪份是对的），本函数只负责执行；两种 as 都会丢弃
// 非准份的内容，因此与 purge 同款：先 --dry-run 看计划，加 --force 才落盘。
export async function dedupeSkill({ name, source, as = 'link', force, dryRun } = {}) {
  name = assertSafeName(name);
  if (as !== 'link' && as !== 'delete') throw badInput('as 只能是 link | delete');
  const entries = await sourceEntriesFor(name);
  const winner = entries.find((e) => samePath(e.source, resolve(String(source || ''))));
  if (!winner) {
    throw notFound(
      `--source 指定的订阅源里没有实文件 ${name}: ${source}` +
      `（实文件来源: ${entries.map((e) => e.source).join(' , ') || '无'}）`
    );
  }
  const others = entries.filter((e) => e !== winner);

  const plan = {
    name,
    as,
    winner: { source: winner.source, dir: winner.dir, md5: winner.md5 },
    others: others.map((e) => ({ source: e.source, dir: e.dir, md5: e.md5 })),
  };
  if (!others.length) {
    return { status: 'ok', dryRun: !!dryRun, name, plan, removed: [], linked: [], note: '本就只有一份实文件，无需处理' };
  }
  if (dryRun) return { status: 'ok', dryRun: true, name, plan, removed: [], linked: [] };

  // 与 purge 的实体副本同款闸门：非准份也是实文件，可能含本地改动，丢弃不可逆
  if (!force) {
    return {
      status: 'blocked',
      dryRun: false,
      name,
      plan,
      removed: [],
      linked: [],
      reason: `${others.length} 份非准实文件将${as === 'delete' ? '被删除' : '被链接替换'}（可能含本地改动），不可逆，加 --force 确认`,
    };
  }

  const { removed, linked, skipped } = await applyDedupeGroup(winner.dir, others, as);
  return { status: 'ok', dryRun: false, name, plan, as, removed, linked, skipped };
}

// 执行一组唯一化：其余实文件删除 → 按要求原位重建为指向准份的链接。
// 建链失败：至少回填一份副本，不让来源凭空丢 skill（与 submitOne 同款兜底）。
async function applyDedupeGroup(winnerDir, others, as) {
  const removed = [];
  const linked = [];
  const skipped = [];
  for (const o of others) {
    if (await sameRealPath(o.dir, winnerDir)) {
      skipped.push({ ...o, reason: '与准份同一实体' });
      continue;
    }
    await fsp.rm(o.dir, { recursive: true, force: true });
    if (as === 'delete') {
      removed.push({ ...o });
      continue;
    }
    const r = await createSkillLink(winnerDir, o.dir);
    if (r.ok) {
      linked.push({ ...o, linkType: r.linkType });
    } else {
      await fsp.cp(winnerDir, o.dir, { recursive: true, dereference: true, force: true });
      removed.push({ ...o, degraded: true, reason: r.error });
    }
  }
  return { removed, linked, skipped };
}

// 批量快捷唯一化：把 sourceAudit 发现的重复/冲突组一次收敛——
// 每组以主源（current）那份实文件为准，其余转链接（as=delete 则删除）。
// names 点名只处理这些组（多选勾选），缺省=全部组；点了名但已不在重复/冲突里
// 的名字进 ignored 回报，不报错（弹窗渲染与点击之间组可能已被处理掉）。
// 链接不算来源（见 scan 的 realOnly），重复/冲突随之消失，而各来源目录里
// 仍能看到这些 skill（访问性不受影响）。组里没有主源实文件时取第一份为准并标注。
export async function dedupeAll({ names, as = 'link', force, dryRun } = {}) {
  if (as !== 'link' && as !== 'delete') throw badInput('as 只能是 link | delete');
  const want = (Array.isArray(names) ? names : names ? [names] : []).map((n) => assertSafeName(n));
  const audit = await sourceAudit();
  const groups = audit.conflicts
    .filter((c) => !want.length || want.includes(c.name))
    .map((c) => {
      const winner = c.entries.find((e) => e.current) || c.entries[0];
      return {
        name: c.name,
        noPrimary: !c.entries.some((e) => e.current),
        winner: { source: winner.source, dir: winner.dir, md5: winner.md5 },
        others: c.entries.filter((e) => e !== winner).map((e) => ({ source: e.source, dir: e.dir, md5: e.md5 })),
      };
    })
    .filter((g) => g.others.length > 0);
  const ignored = want.filter((n) => !groups.some((g) => g.name === n));
  const totals = { groups: groups.length, linked: 0, removed: 0, skipped: 0, degraded: 0 };
  if (!groups.length) {
    return { status: 'ok', dryRun: !!dryRun, as, groups: [], ignored, totals, note: '没有跨源重复/冲突，无需处理' };
  }
  if (dryRun) return { status: 'ok', dryRun: true, as, groups, ignored, totals };
  if (!force) {
    return {
      status: 'blocked',
      dryRun: false,
      as,
      groups,
      ignored,
      totals,
      reason: `${totals.groups} 组重复/冲突的非准实文件将${as === 'delete' ? '被删除' : '被链接替换'}（可能含本地改动），不可逆，加 --force 确认`,
    };
  }
  const results = [];
  for (const g of groups) {
    const r = await applyDedupeGroup(g.winner.dir, g.others, as);
    totals.linked += r.linked.length;
    totals.removed += r.removed.length;
    totals.skipped += r.skipped.length;
    totals.degraded += r.removed.filter((x) => x.degraded).length;
    results.push({ name: g.name, noPrimary: g.noPrimary, winner: g.winner, ...r });
  }
  return { status: 'ok', dryRun: false, as, groups: results, ignored, totals };
}
