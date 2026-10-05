// skill 实体的增改删（只动订阅源里那份实文件）。
//
// 读（R）由 queries 的 skillInfo / skillContent 承担；迁移覆盖目标副本，
// 所以这里不需要「同步到目标」。
// 刻意不声明 resource: 'skill'——`skill get` 这个 CLI 已被内置手册占用（bundled 模块），
// CRUD 断言要求的 get 动词没法按 A00 命名；不改名就不硬凑。
import { join } from 'node:path';
import fsp from 'node:fs/promises';
import { exists, pathExists } from '../../../core/fstree.js';
import { parseFrontmatter } from '../../../core/frontmatter.js';
import { assertSafeName } from '../../../core/paths.js';
import { badInput, notFound, conflict } from '../../../core/errors.js';
import { detectLinkType } from '../../../core/link.js';
import { hubPath, requireHubPath } from '../../settings/service.js';
import { resolveSkillsRoot } from './scan.js';
import { sourceEntriesFor } from './sources.js';
import { resolveTargets } from './targets.js';

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
