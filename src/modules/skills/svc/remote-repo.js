// 远程订阅仓库：唯一一个装着「外部 skill」的容器，落位 ~/.nx-rh/远程订阅/（名字固定）。
//
// 模型（与「多个远程订阅源」是两回事）：
//   - 「远程订阅」是**一个**独立仓库（与本地 skill hub 同级、各自一个源），
//     目录布局 <repo>/<name>/SKILL.md
//   - 仓库里既有**实体**（从网上导入或手写定义），也可以有**软链**（链到别处，
//     便于同一份源码多处使用）——链接不参与版本管理，但能像实体一样被迁移/引用
//   - 每个实体带自己的来源与版本元数据：{ spec, url, ref, hash, importedAt, updatedAt }
//     hash 就是它的「版本」，updatedAt 就是「何时更新的」
//   - 支持的操作：搜索（skills.sh）→ 确认导入；添加定义；按版本更新；移除；加软链
//   - 它参与本地流程：里面的 skill 可以照常 migrate 到各平台目录
//
// 导入与更新的共同骨架是 remote.js 的 materializeRemote（拉取到 staging）——
// 与普通订阅同一条落地路径，只是落地终点从「源目录」变成「远程订阅仓库里的某个 skill」。
import fsp from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { remoteRepoDir, assertSafeName } from '../../../core/paths.js';
import { badInput, conflict, notFound } from '../../../core/errors.js';
import { loadStore, mutateStore } from '../../../core/store.js';
import { detectLinkType } from '../../../core/link.js';
import { parseSource } from './remote-parse.js';
import { materializeRemote } from './remote.js';
import { resolveSkillsRoot, scanSkillsRoot, skillDirHash, readSkill } from './scan.js';

const now = () => new Date().toISOString();

// 远程订阅仓库目录 + 登记为订阅源（幂等）：它的 skill 之后能像普通源一样被 migrate
export async function ensureRemote() {
  const dir = remoteRepoDir();
  await fsp.mkdir(dir, { recursive: true });
  await mutateStore((s) => {
    s.remoteRepo.dir = dir;
    const list = s.settings.skillHubSources;
    if (!list.some((p) => p.toLowerCase() === dir.toLowerCase())) list.push(dir);
  });
  return dir;
}

export async function remoteRepoState() {
  const s = await loadStore();
  return s.remoteRepo || { dir: remoteRepoDir(), skills: {} };
}

// 远程订阅仓库里的 skill 清单：实体 + 软链，各带版本元数据（remoteContents —— 不叫 listHubSkills，
// 那个名字已被 sources.js 的「订阅源 skill 列表」占用，barrel 的 export * 会静默丢弃重名）
export async function remoteContents() {
  const st = await remoteRepoState();
  const dir = st.dir || remoteRepoDir();
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

// 导入：把远程规格里的 skill 拉进远程订阅仓库（默认整仓导入，name 只导一个）
export async function importToRemote(spec, { name } = {}) {
  const parsed = parseSource(spec);
  if (parsed.type === 'local') {
    throw badInput('远程订阅仓库只收远程规格（owner/repo、git URL、归档 URL）；手写定义用 skill hub remote add');
  }
  parsed.spec = spec;
  const dir = await ensureRemote();
  const { staging, sourceDir } = await materializeRemote(parsed);
  try {
    const root = await resolveSkillsRoot(sourceDir);
    const skills = await scanSkillsRoot(root, { realOnly: true });
    if (!skills.length) throw badInput('上游里没有找到 skill: ' + spec);
    const wanted = name ? skills.filter((s) => s.name === name) : skills;
    if (name && !wanted.length) throw notFound('上游里没有这个 skill: ' + name + '（' + spec + '）');

    const stamp = now();
    const imported = [];
    for (const sk of wanted) {
      // sk.dir 是**上游目录**（可能与 frontmatter 的 name 不同：目录叫
      // composition-patterns、name 却是 vercel-composition-patterns），
      // 实体拷贝按目录走，仓库里的落位名用 name（这样列表/migrate 对得上）。
      // name 来自上游 frontmatter——**不可信**，必须过安全名校验，
      // 否则 `name: ../../evil` 会写到仓库目录之外。
      const safeName = assertSafeName(sk.name, '上游 skill 名称');
      const hash = await skillDirHash(sk.dir);
      const target = join(dir, safeName);
      await fsp.rm(target, { recursive: true, force: true });
      await fsp.cp(sk.dir, target, { recursive: true });
      imported.push({
        name: safeName,
        description: sk.description,
        hash,
        spec,
        url: parsed.url,
        ref: parsed.ref || '',
        skillPath: safeName,
      });
    }
    await mutateStore((s) => {
      s.remoteRepo.dir = dir;
      for (const it of imported) {
        const prev = s.remoteRepo.skills[it.name] || {};
        s.remoteRepo.skills[it.name] = { ...it, importedAt: prev.importedAt || stamp, updatedAt: stamp };
      }
    });
    return { dir, spec, imported: imported.map((i) => i.name), count: imported.length };
  } finally {
    await fsp.rm(staging, { recursive: true, force: true });
  }
}

// 手工添加定义：在远程订阅仓库里新建一个 skill（自己写 SKILL.md）——不是从任何地方导入
export async function addRemoteDefinition(name, { description, content } = {}) {
  if (!name) throw badInput('用法: nx-rh skill hub remote add <name> [--description <描述>] [--content <正文>]');
  const safeName = assertSafeName(name, 'skill 名称');
  const dir = await ensureRemote();
  const target = join(dir, safeName);
  if (await fsp.stat(target).catch(() => null)) {
    throw conflict('远程订阅仓库里已经有这个 skill: ' + safeName);
  }
  const desc = description || '（手工添加的定义）';
  const body = content || `# ${safeName}\n`;
  const md = `---\nname: ${safeName}\ndescription: ${desc}\n---\n\n${body}\n`;
  await fsp.mkdir(target, { recursive: true });
  await fsp.writeFile(join(target, 'SKILL.md'), md, 'utf8');
  const hash = await skillDirHash(target);
  const stamp = now();
  await mutateStore((s) => {
    s.remoteRepo.dir = dir;
    s.remoteRepo.skills[safeName] = {
      name: safeName, description: desc, hash, spec: '', url: '', ref: '', skillPath: safeName,
      importedAt: stamp, updatedAt: stamp,
    };
  });
  return { dir, name: safeName, hash, imported: [safeName] };
}

// 链入：把别处已有的 skill 软链**进**远程订阅仓库（<name> <目标目录>）
export async function linkIntoRemote(name, target) {
  if (!name || !target) throw badInput('用法: nx-rh skill hub remote link <name> <目标目录>');
  const safeName = assertSafeName(name, '软链名');
  const dir = await ensureRemote();
  const link = join(dir, safeName);
  if (await fsp.lstat(link).catch(() => null)) {
    throw conflict('远程订阅仓库里已经有这个名字: ' + safeName);
  }
  const abs = target;
  const info = await readSkill(abs);
  if (!info) throw notFound('目标目录里没有 SKILL.md: ' + abs);
  await fsp.symlink(abs, link, 'junction');
  // 链接没有上游：登记为「无上游」条目（spec 空），更新时自动跳过
  const hash = await skillDirHash(abs);
  const stamp = now();
  await mutateStore((s) => {
    s.remoteRepo.dir = dir;
    s.remoteRepo.skills[safeName] = {
      name: safeName, description: info.description, hash,
      spec: '', url: '', ref: '', skillPath: safeName,
      importedAt: stamp, updatedAt: stamp, link: abs,
    };
  });
  return { dir, name: safeName, target: abs, linkType: (await detectLinkType(link)) || 'symlink' };
}

// 链出：把远程订阅仓库里的某份 skill 链到别处（<name> <目标目录>）
// 与「链入」相反：容器里这份**不动**，在目标位置建一个指向它的链接。
export async function linkFromRemote(name, target) {
  const safeName = assertSafeName(name, 'skill 名称');
  const st = await remoteRepoState();
  const dir = st.dir || remoteRepoDir();
  const src = join(dir, safeName);
  if (!(await fsp.lstat(src).catch(() => null))) {
    throw notFound('远程订阅仓库里没有这个 skill: ' + safeName);
  }
  const abs = target;
  if (await fsp.lstat(abs).catch(() => null)) {
    throw conflict('目标位置已存在: ' + abs);
  }
  await fsp.mkdir(dirname(abs), { recursive: true });
  await fsp.symlink(src, abs, 'junction');
  return { name: safeName, from: src, to: abs, linkType: (await detectLinkType(abs)) || 'symlink' };
}

// 更新：按来源重拉，逐 skill 比对指纹——变了才换（未变不动），上游没了报「已移除」
export async function updateRemote(names) {
  const st = await remoteRepoState();
  const entries = Object.entries(st.skills || {});
  const wanted = Array.isArray(names) && names.length ? names : null;
  const targets = wanted ? entries.filter(([n]) => wanted.includes(n)) : entries;
  if (!targets.length) {
    return { status: 'ok', results: [], note: '远程订阅仓库里还没有可更新的 skill（先 import 或 add）' };
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
        const hash = await skillDirHash(up.dir);
        if (hash === meta.hash) {
          results.push({ name, status: 'unchanged', hash });
          continue;
        }
        // 写盘目标必须与读取同源（remoteContents 读的是 st.dir）——
        // 曾经这里用 remoteRepoDir()，两者不一致时会出现「更新完界面没变化」。
        const target = join(st.dir || remoteRepoDir(), name);
        await fsp.rm(target, { recursive: true, force: true });
        await fsp.cp(up.dir, target, { recursive: true });
        await mutateStore((s) => {
          s.remoteRepo.skills[name] = { ...meta, hash, updatedAt: now() };
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

// 从远程订阅仓库移除（只动仓库里的条目 + 元数据；平台侧副本另行 purge）
export async function removeFromRemote(names) {
  const list = Array.isArray(names) ? names : names ? [names] : [];
  if (!list.length) throw badInput('用法: nx-rh skill hub remote remove <name...>');
  const st = await remoteRepoState();
  const dir = st.dir || remoteRepoDir();
  const removed = [];
  for (const name of list) {
    if (!st.skills[name]) {
      const exists = await fsp.lstat(join(dir, name)).catch(() => null);
      if (!exists) continue; // 不在 Hub 里就不是错误（幂等）
    }
    await fsp.rm(join(dir, name), { recursive: true, force: true });
    await mutateStore((s) => { delete s.remoteRepo.skills[name]; });
    removed.push(name);
  }
  return { dir, removed };
}

// 同步「远程订阅仓库」的元数据：磁盘上的实体被删 / 变成链接时，
// 远端版本追踪必须跟着改——否则 remote update 会把已删的 skill 从上游**复活**。
// mode: 'removed' 删条目；'linked' 清掉上游信息（链接没有自己的来源）。
export async function syncRemoteMeta(name, mode) {
  if (!name) return;
  const st = await remoteRepoState();
  const meta = st.skills?.[name];
  if (!meta) return; // 不在远程订阅仓库里，与本工具无关
  await mutateStore((s) => {
    if (!s.remoteRepo.skills) return;
    if (mode === 'removed') {
      delete s.remoteRepo.skills[name];
      return;
    }
    if (mode === 'linked') {
      s.remoteRepo.skills[name] = { ...s.remoteRepo.skills[name], spec: '', url: '', ref: '' };
    }
  });
}
