// 远程 Hub：唯一一个装着「外部 skill」的容器（落位 ~/.nx-rh/remote-hub/）。
//
// 模型（与「多个远程订阅源」是两回事）：
//   - 远程 Hub 是**一个**订阅源，目录布局 <hub>/<name>/SKILL.md
//   - Hub 里既有**实体**（从网上导入或手写定义），也可以有**软链**（链到别处，
//     便于同一份源码多处使用）——链接不参与版本管理，但能像实体一样被迁移/引用
//   - 每个实体带自己的来源与版本元数据：{ spec, url, ref, hash, importedAt, updatedAt }
//     hash 就是它的「版本」，updatedAt 就是「何时更新的」
//   - 支持的操作：搜索（skills.sh）→ 确认导入；添加定义；按版本更新；移除；加软链
//   - Hub 本身参与本地流程：它的 skill 可以照常 migrate 到各平台目录
//
// 导入与更新的共同骨架是 remote.js 的 materializeRemote（拉取到 staging）——
// 与普通订阅同一条落地路径，只是落地终点从「源目录」变成「Hub 里的某个 skill」。
import fsp from 'node:fs/promises';
import { join } from 'node:path';
import { remoteHubDir } from '../../../core/paths.js';
import { badInput, conflict, notFound } from '../../../core/errors.js';
import { loadStore, mutateStore } from '../../../core/store.js';
import { detectLinkType } from '../../../core/link.js';
import { parseSource } from './remote-parse.js';
import { materializeRemote } from './remote.js';
import { resolveSkillsRoot, scanSkillsRoot, skillDirHash, readSkill } from './scan.js';

const now = () => new Date().toISOString();

// Hub 目录 + 登记为订阅源（幂等）：Hub 的 skill 之后能像普通源一样被 migrate
export async function ensureHub() {
  const dir = remoteHubDir();
  await fsp.mkdir(dir, { recursive: true });
  await mutateStore((s) => {
    s.remoteHub.dir = dir;
    const list = s.settings.skillHubSources;
    if (!list.some((p) => p.toLowerCase() === dir.toLowerCase())) list.push(dir);
  });
  return dir;
}

export async function hubState() {
  const s = await loadStore();
  return s.remoteHub || { dir: remoteHubDir(), skills: {} };
}

// Hub 里的 skill 清单：实体 + 软链，各带版本元数据（hubContents —— 不叫 listHubSkills，
// 那个名字已被 sources.js 的「订阅源 skill 列表」占用，barrel 的 export * 会静默丢弃重名）
export async function hubContents() {
  const st = await hubState();
  const dir = st.dir || remoteHubDir();
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    if (e.name.startsWith('.')) continue;
    const path = join(dir, e.name);
    const info = await readSkill(path);
    if (!info) continue;
    const meta = st.skills[e.name] || {};
    const linkType = await detectLinkType(path);
    out.push({
      name: e.name,
      description: info.description,
      dir: path,
      linkType: linkType || '',
      hash: meta.hash || (await skillDirHash(path)),
      spec: meta.spec || '',
      url: meta.url || '',
      ref: meta.ref || '',
      importedAt: meta.importedAt || '',
      updatedAt: meta.updatedAt || meta.importedAt || '',
      // 软链没有上游（不参与版本更新）；手工定义同理
      manual: !meta.spec,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { dir, skills: out };
}

// 导入：把远程规格里的 skill 拉进 Hub（默认整仓导入，name 只导一个）
export async function importToHub(spec, { name } = {}) {
  const parsed = parseSource(spec);
  if (parsed.type === 'local') {
    throw badInput('远程 Hub 只收远程规格（owner/repo、git URL、归档 URL）；手写定义用 skill hub remote add');
  }
  parsed.spec = spec;
  const dir = await ensureHub();
  const { staging, sourceDir } = await materializeRemote(parsed);
  try {
    const root = await resolveSkillsRoot(sourceDir);
    const skills = await scanSkillsRoot(root, { realOnly: true });
    if (!skills.length) throw badInput('远程源里没有找到 skill: ' + spec);
    const wanted = name ? skills.filter((s) => s.name === name) : skills;
    if (name && !wanted.length) throw notFound('远程源里没有这个 skill: ' + name + '（' + spec + '）');

    const stamp = now();
    const imported = [];
    for (const sk of wanted) {
      const hash = await skillDirHash(join(root, sk.name));
      const target = join(dir, sk.name);
      await fsp.rm(target, { recursive: true, force: true });
      await fsp.cp(join(root, sk.name), target, { recursive: true });
      imported.push({
        name: sk.name,
        description: sk.description,
        hash,
        spec,
        url: parsed.url,
        ref: parsed.ref || '',
        skillPath: sk.name,
      });
    }
    await mutateStore((s) => {
      s.remoteHub.dir = dir;
      for (const it of imported) {
        const prev = s.remoteHub.skills[it.name] || {};
        s.remoteHub.skills[it.name] = { ...it, importedAt: prev.importedAt || stamp, updatedAt: stamp };
      }
    });
    return { dir, spec, imported: imported.map((i) => i.name), count: imported.length };
  } finally {
    await fsp.rm(staging, { recursive: true, force: true });
  }
}

// 手工添加定义：在 Hub 里新建一个 skill（自己写 SKILL.md）——不是从任何地方导入
export async function addHubDefinition(name, { description, content } = {}) {
  if (!name) throw badInput('用法: nx-rh skill hub remote add <name> [--description <描述>] [--content <正文>]');
  const dir = await ensureHub();
  const target = join(dir, name);
  if (await fsp.stat(target).catch(() => null)) {
    throw conflict('远程 Hub 里已经有这个 skill: ' + name);
  }
  const desc = description || '（手工添加的定义）';
  const body = content || `# ${name}\n`;
  const md = `---\nname: ${name}\ndescription: ${desc}\n---\n\n${body}\n`;
  await fsp.mkdir(target, { recursive: true });
  await fsp.writeFile(join(target, 'SKILL.md'), md, 'utf8');
  const hash = await skillDirHash(target);
  const stamp = now();
  await mutateStore((s) => {
    s.remoteHub.dir = dir;
    s.remoteHub.skills[name] = {
      name, description: desc, hash, spec: '', url: '', ref: '', skillPath: name,
      importedAt: stamp, updatedAt: stamp,
    };
  });
  return { dir, name, hash, imported: [name] };
}

// 加软链：把 Hub 里的某个 skill 链到别处已有的目录（同一份源码多处可用）
export async function linkIntoHub(name, target) {
  if (!name || !target) throw badInput('用法: nx-rh skill hub remote link <name> <目标目录>');
  const dir = await ensureHub();
  const link = join(dir, name);
  if (await fsp.lstat(link).catch(() => null)) {
    throw conflict('远程 Hub 里已经有这个名字: ' + name);
  }
  const abs = target;
  const info = await readSkill(abs);
  if (!info) throw notFound('目标目录里没有 SKILL.md: ' + abs);
  await fsp.symlink(abs, link, 'junction');
  return { dir, name, target: abs, linkType: (await detectLinkType(link)) || 'symlink' };
}

// 更新：按来源重拉，逐 skill 比对指纹——变了才换（未变不动），上游没了报「已移除」
export async function updateHub(names) {
  const st = await hubState();
  const entries = Object.entries(st.skills || {});
  const wanted = Array.isArray(names) && names.length ? names : null;
  const targets = wanted ? entries.filter(([n]) => wanted.includes(n)) : entries;
  if (!targets.length) {
    return { status: 'ok', results: [], note: '远程 Hub 里还没有可更新的 skill（先 import 或 add）' };
  }
  // 同一来源只拉一次
  const bySpec = new Map();
  const results = [];
  for (const [name, meta] of targets) {
    if (!meta.spec) {
      results.push({ name, status: 'skipped', reason: '手工定义 / 软链，没有上游可更新' });
      continue;
    }
    if (!bySpec.has(meta.spec)) bySpec.set(meta.spec, []);
    bySpec.get(meta.spec).push([name, meta]);
  }
  for (const [spec, items] of bySpec) {
    let staging = '';
    try {
      const parsed = parseSource(spec);
      parsed.spec = spec;
      const m = await materializeRemote(parsed);
      staging = m.staging;
      const root = await resolveSkillsRoot(m.sourceDir);
      const upstream = new Map((await scanSkillsRoot(root, { realOnly: true })).map((s) => [s.name, s]));
      for (const [name, meta] of items) {
        const up = upstream.get(name);
        if (!up) {
          results.push({ name, status: 'removed', reason: '上游已没有这个 skill' });
          continue;
        }
        const hash = await skillDirHash(join(root, name));
        if (hash === meta.hash) {
          results.push({ name, status: 'unchanged', hash });
          continue;
        }
        const target = join(remoteHubDir(), name);
        await fsp.rm(target, { recursive: true, force: true });
        await fsp.cp(join(root, name), target, { recursive: true });
        await mutateStore((s) => {
          s.remoteHub.skills[name] = { ...meta, hash, updatedAt: now() };
        });
        results.push({ name, status: 'updated', hash, from: meta.hash });
      }
    } catch (err) {
      results.push({ name: spec, status: 'error', error: String((err && err.message) || err) });
    } finally {
      if (staging) await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }
  return { status: 'ok', results };
}

// 从 Hub 移除（只动 Hub 里的条目 + 元数据；平台侧副本另行 purge）
export async function removeFromHub(names) {
  const list = Array.isArray(names) ? names : names ? [names] : [];
  if (!list.length) throw badInput('用法: nx-rh skill hub remote remove <name...>');
  const st = await hubState();
  const dir = st.dir || remoteHubDir();
  const removed = [];
  for (const name of list) {
    if (!st.skills[name]) {
      const exists = await fsp.lstat(join(dir, name)).catch(() => null);
      if (!exists) continue; // 不在 Hub 里就不是错误（幂等）
    }
    await fsp.rm(join(dir, name), { recursive: true, force: true });
    await mutateStore((s) => { delete s.remoteHub.skills[name]; });
    removed.push(name);
  }
  return { dir, removed };
}
