// 远程订阅仓库：唯一一个装着「外部 skill」的容器，落位 ~/.nx-rh/远程订阅/（名字固定）。
//
// 模型（与「多个远程订阅源」是两回事）：
//   - 「远程订阅」是**一个**独立仓库（与本地 skill hub 同级、各自一个源），
//     目录布局 <repo>/<name>/SKILL.md
//   - 仓库里装的是**实体**（从网上导入或手写定义）——它就是个普通的本地
//     skill hub，「导入 + 装到平台目录」是它的全部职责，不另立软链概念
//     （软链在本地 hub 侧已有 submit / dedupe --as link 一套）
//   - 每个实体带自己的来源与版本元数据：
//     { spec, url, ref, hash, folderHash, repoPath, importedAt, updatedAt }
//     hash = 本地副本指纹（md5，决定要不要换盘）
//     folderHash = 上游指纹（git 源 = 目录 tree SHA，决定上游有没有变）
//   - 支持的操作：搜索（skills.sh）→ 确认导入；按版本检查/更新；增删改查
//   - 它参与本地流程：里面的 skill 可以照常 migrate 到各平台目录
//
// 导入与更新的共同骨架是 remote.js 的 materializeRemote（拉取到 staging）——
// 与普通订阅同一条落地路径，只是落地终点从「源目录」变成「远程订阅仓库里的某个 skill」。
import fsp from 'node:fs/promises';
import { basename, join } from 'node:path';
import { remoteRepoDir, assertSafeName } from '../../../core/paths.js';
import { badInput, conflict, notFound } from '../../../core/errors.js';
import { loadStore, mutateStore } from '../../../core/store.js';
import { detectLinkType } from '../../../core/link.js';
import { parseSource } from './remote-parse.js';
import { materializeRemote } from './remote.js';
import { resolveSkillsRoot, scanSkillsRoot, skillDirHash, readSkill } from './scan.js';
import { resolveTargets } from './targets.js';
import { pathExists } from '../../../core/fstree.js';
import { fingerprintsFromStaging, relDirFor, headCommit, upstreamFingerprintOf } from './version.js';
const now = () => new Date().toISOString();

// 远程订阅仓库目录 + 登记为订阅源（幂等）：它的 skill 之后能像普通源一样被 migrate
//
// **默认登记**：远程 hub 是本工具托管的容器，不需要用户先「订阅」它——
// 一开始就把它列进订阅源清单（恒排末位，见 svc/sources.js 的排序），
// 这样总览的订阅源列表里天然有它，导入的 skill 立刻可迁移。
//
// 幂等且便宜：已登记过就直接返回，不做 mkdir、不写 store——
// listSources 每次读订阅源清单都会调它，不能每次都落盘。
export async function ensureRemote() {
  const st = await loadStore();
  const dir = remoteRepoDir();
  const registered = (st.settings?.skillHubSources || [])
    .some((p) => String(p).toLowerCase() === dir.toLowerCase());
  if (st.remoteRepo?.dir === dir && registered) return dir;

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
  return s.remoteRepo || { dir: remoteRepoDir(), skills: {}, commits: {}, lastCheck: null };
}

// 远程订阅仓库里的 skill 清单：实体，各带版本元数据（remoteContents —— 不叫 listHubSkills，
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
    const commit = meta.spec ? st.commits?.[meta.spec]?.commit || '' : '';
    out.push({
      name: e.name,
      description: info.description,
      dir: path,
      linkType: linkType || '',
      // hash = 本地副本指纹；folderHash = 上游指纹（版本比对的基准）
      hash: meta.hash || (await skillDirHash(path)),
      folderHash: meta.folderHash || '',
      repoPath: meta.repoPath || '',
      spec: meta.spec || '',
      url: meta.url || '',
      ref: meta.ref || '',
      commit,
      importedAt: meta.importedAt || '',
      updatedAt: meta.updatedAt || meta.importedAt || '',
      // 软链没有上游（不参与版本更新）；手工定义同理
      manual: !meta.spec,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return {
    dir,
    skills: out,
    // 上次检查的结论摘要：面板的「待更新」徽标读它，不必每次点开都联网
    lastCheck: st.lastCheck || null,
    commits: st.commits || {},
  };
}

// 远程订阅内容 + 安装状态（cells）：与本地源的 skill 行同投影，Web 卡片直接用。
// lastCheck / commits 一并带出——面板的「待更新」徽标读 lastCheck，不必联网。
export async function remoteContentsWithCells({ project } = {}) {
  const { skills, dir, lastCheck, commits } = await remoteContents();
  const targets = await resolveTargets({ to: 'all', project });
  const out = [];
  for (const s of skills) {
    const cells = [];
    for (const t of targets) {
      const p = join(t.dir, s.name);
      const on = await pathExists(p);
      cells.push({
        platform: t.platform, platformName: t.platformName, scope: t.scope, dir: p, on,
        linkType: on ? await detectLinkType(p) : '',
      });
    }
    out.push({ ...s, cells });
  }
  return { dir, skills: out, lastCheck, commits };
}

// 导入：把远程规格里的 skill 拉进远程订阅仓库（默认整仓导入，name 只导一个）
export async function importToRemote(spec, { name, dryRun } = {}) {
  const parsed = parseSource(spec);
  if (parsed.type === 'local') {
    throw badInput('远程订阅仓库只收远程规格（owner/repo、git URL、归档 URL）；手写定义用 skill hub remote add');
  }
  parsed.spec = spec;
  const { staging, sourceDir } = await materializeRemote(parsed);
  try {
    const root = await resolveSkillsRoot(sourceDir);
    const skills = await scanSkillsRoot(root, { realOnly: true });
    if (!skills.length) throw badInput('上游里没有找到 skill: ' + spec);
    const wanted = name ? skills.filter((s) => s.name === name) : skills;
    if (name && !wanted.length) throw notFound('上游里没有这个 skill: ' + name + '（' + spec + '）');

    // --dry-run（对标参考实现的 add --list）：先看清上游有什么再决定导不导。
    // staging 已拉完，只列不拷——Web 确认弹窗也走这条。
    if (dryRun) {
      const preview = [];
      for (const sk of wanted) {
        preview.push({
          name: assertSafeName(sk.name, '上游 skill 名称'),
          description: sk.description,
          hash: await skillDirHash(sk.dir),
        });
      }
      preview.sort((a, b) => a.name.localeCompare(b.name));
      return { status: 'ok', dryRun: true, spec, dir: '', url: parsed.url, ref: parsed.ref || '', skills: preview, count: preview.length };
    }

    // 上游指纹：导入时就把「上游目录指纹」记进台账，版本检查才有基准。
    // 仓库已经克隆到 staging 了，直接从它算——不再克隆第二份。
    // 采集失败不阻断导入：拿不到基准只是首次检查报 unknown，导入本身是成功的。
    let upstream = { fingerprints: new Map(), commit: '' };
    try {
      upstream = await fingerprintsFromStaging(
        staging,
        sourceDir,
        wanted.map((s) => [s.name, { absDir: s.dir, skillPath: basename(s.dir) }]),
        parsed
      );
    } catch {
      upstream = { fingerprints: new Map(), commit: '' };
    }

    const dir = await ensureRemote();
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
      const fp = upstream.fingerprints.get(sk.name);
      imported.push({
        name: safeName,
        description: sk.description,
        hash,
        // 上游指纹（版本比对的基准）与它在仓库里的相对路径
        folderHash: fp?.sha || '',
        repoPath: fp?.relDir ? fp.relDir + '/SKILL.md' : relDirFor(sk.dir, staging) + '/SKILL.md',
        spec,
        url: parsed.url,
        ref: parsed.ref || '',
        // 上游**原目录名**：上游只是挪目录（frontmatter name 没变）时，
        // update 靠它重定位，不至于误报 removed。
        skillPath: basename(sk.dir),
      });
    }
    await mutateStore((s) => {
      s.remoteRepo.dir = dir;
      for (const it of imported) {
        const prev = s.remoteRepo.skills[it.name] || {};
        s.remoteRepo.skills[it.name] = { ...it, importedAt: prev.importedAt || stamp, updatedAt: stamp };
      }
      if (upstream.commit) {
        s.remoteRepo.commits[spec] = { commit: upstream.commit, checkedAt: stamp };
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

// 导入 + 安装一条龙：把远程规格拉进远程订阅，并装到目标平台目录。
//
// 这是 vercel-labs/skills 的 `skills add` 的对标物（那边是「clone + 装到 agent 目录」，
// 这边是「clone + 装到平台目录」——平台适配器沿用本仓库自己的 ADAPTERS 表）。
//
// 为什么不把 install 做成 import 的副作用：import 的语义是「收进容器」，
// install 的语义是「落到平台目录」——两件事的失败后果不同（前者只是台账/实体，
// 后者会在用户目录留下文件）。分开之后，import 仍可单独用于「先收着，之后再铺」。
export async function installFromRemote(spec, { name, to, platform, project, dryRun } = {}) {
  // --dry-run：只列上游有什么，不导入也不安装（与 import --dry-run 同一形态）
  if (dryRun) {
    const preview = await importToRemote(spec, { name, dryRun: true });
    return {
      status: 'ok', dryRun: true, spec,
      skills: preview.skills, count: preview.count,
      imported: [], install: null,
    };
  }

  const imported = await importToRemote(spec, { name });
  const names = imported.imported;
  if (!names.length) {
    return { status: 'ok', spec, imported: [], count: 0, install: null };
  }

  // 迁移到目标：走现成的 transfer 层（订阅源 → 平台目录）
  const { migrateSkill } = await import('./transfer.js');
  const install = await migrateSkill({
    name: names,
    to: to || 'user',
    platform: platform || undefined,
    project,
  });

  return {
    status: install.status === 'blocked' ? 'blocked' : 'ok',
    spec,
    imported: names,
    count: names.length,
    install,
  };
}

// 更新：按来源重拉，逐 skill 比对指纹——变了才换（未变不动），上游没了报「已移除」
export async function updateRemote(names, { prune } = {}) {
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
      const upstreamByPath = new Map(
        (await scanSkillsRoot(root, { realOnly: true })).map((s) => [basename(s.dir), s])
      );
      // 上游 commit（记进台账，下次检查走 ls-remote 快路径）
      let commit = '';
      try {
        commit = await headCommit(m.staging);
      } catch {
        commit = '';
      }
      for (const [name, meta] of items) {
        // 重定位（对齐 vercel-labs/skills src/skill-relocation.ts 的思路）：
        // 上游按 frontmatter name 找不到时，先按**原目录名**（台账 skillPath）
        // 找一次——上游改了 name、目录还是那个目录时，照常更新而不是误报 removed。
        const byName = upstream.get(name);
        const up = byName || upstreamByPath.get(meta.skillPath || '');
        const relocated = !byName && !!up;
        if (!up) {
          results.push({ name, status: 'removed', reason: '上游已没有这个 skill（frontmatter name 与原目录都对不上）' });
          if (prune) {
            const target = join(st.dir || remoteRepoDir(), name);
            await fsp.rm(target, { recursive: true, force: true });
            await mutateStore((s) => { delete s.remoteRepo.skills[name]; });
            results[results.length - 1].pruned = true;
          }
          continue;
        }
        // 上游指纹（版本基准）：仓库已经拉好了，直接从 staging 算树对象 SHA
        const fp = await upstreamFingerprintOf(m.staging, up.dir, parsed);
        const hash = await skillDirHash(up.dir);
        if (hash === meta.hash) {
          // 内容没变，但上游路径可能挪了——台账的 repoPath 要跟上，
          // 否则下次版本检查定位不到（会误报 removed）。
          if (fp.relDir !== null && (meta.repoPath || '') !== (fp.relDir ? fp.relDir + '/SKILL.md' : 'SKILL.md')) {
            await mutateStore((s) => {
              if (!s.remoteRepo.skills[name]) return;
              s.remoteRepo.skills[name].repoPath = fp.relDir ? fp.relDir + '/SKILL.md' : 'SKILL.md';
              if (fp.sha) s.remoteRepo.skills[name].folderHash = fp.sha;
            });
          }
          results.push({ name, status: 'unchanged', hash });
          continue;
        }
        // 写盘目标必须与读取同源（remoteContents 读的是 st.dir）——
        // 曾经这里用 remoteRepoDir()，两者不一致时会出现「更新完界面没变化」。
        const target = join(st.dir || remoteRepoDir(), name);
        await fsp.rm(target, { recursive: true, force: true });
        await fsp.cp(up.dir, target, { recursive: true });
        await mutateStore((s) => {
          if (!s.remoteRepo.skills[name]) return;
          s.remoteRepo.skills[name] = {
            ...s.remoteRepo.skills[name],
            hash,
            folderHash: fp.sha || s.remoteRepo.skills[name].folderHash || '',
            repoPath: fp.relDir !== null
              ? (fp.relDir ? fp.relDir + '/SKILL.md' : 'SKILL.md')
              : s.remoteRepo.skills[name].repoPath || '',
            updatedAt: now(),
            skillPath: basename(up.dir),
          };
        });
        results.push({ name, status: 'updated', hash, from: meta.hash, ...(relocated ? { relocated: true } : {}) });
      }
      if (commit) {
        await mutateStore((s) => {
          s.remoteRepo.commits[spec] = { commit, checkedAt: now() };
        });
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

// submit 落入远程订阅仓库时的台账登记：与 import/add/link 一样，凡是写方都登记。
// 用户从平台侧收进来的 skill 没有上游（spec 空 = 手写定义语义），更新时自然跳过；
// 但指纹要记——下次 update 的 unchanged/changed 判定才有基准。
export async function upsertRemoteSubmitMeta(name, fromDir) {
  const dir = await ensureRemote();
  const info = await readSkill(join(dir, name));
  const hash = await skillDirHash(join(dir, name));
  const stamp = now();
  await mutateStore((s) => {
    s.remoteRepo.dir = dir;
    const prev = s.remoteRepo.skills[name] || {};
    s.remoteRepo.skills[name] = {
      name,
      description: info?.description || '',
      hash,
      spec: prev.spec || '',
      url: prev.url || '',
      ref: prev.ref || '',
      skillPath: name,
      importedAt: prev.importedAt || stamp,
      updatedAt: stamp,
      submittedFrom: fromDir,
    };
  });
}
