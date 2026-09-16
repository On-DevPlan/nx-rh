// Skill 管理 service：中心仓库 <-> 项目两侧的识别、软链接/复制同步、冲突分析。
// 链接算法移植自 vercel-labs/skills 的 installer.ts（junction/权限降级/自指防护），
// 业务语义（中心仓库 + 分组）延续 br_controller 的 fileops.go 设计。
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import fsp from 'node:fs/promises';
import { unifiedDiff } from '../../core/diff.js';
import { exists, pathExists, md5Of, diffTrees } from '../../core/fstree.js';
import { parseFrontmatter } from '../../core/frontmatter.js';
import { detectLinkType, createSkillLink, sameRealPath } from '../../core/link.js';
import { assertSafeName, assertSafeRelPath } from '../../core/paths.js';
import { badInput, notFound } from '../../core/errors.js';
import { ADAPTERS } from './adapters.js';
import { centralPath, getSettings } from '../settings/service.js';

// 平台适配器表见 ./adapters.js；设置读写见 ../settings/service.js（基础模块，单向只读依赖）。

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

// ─── 两侧扫描 ──────────────────────────────────────────────────────

// 中心仓库布局：根目录下直接是 skill 目录；兼容早期的 {central}/skills/<name>（只读）
async function centralSkillDir(central, name) {
  const root = join(central, name);
  if (await exists(join(root, 'SKILL.md'))) return root;
  const legacy = join(central, 'skills', name);
  if (await exists(join(legacy, 'SKILL.md'))) return legacy;
  return null;
}

export async function listSkills(side = 'central', explicitPath) {
  if (side === 'central') {
    const central = explicitPath ? resolve(String(explicitPath)) : await centralPath();
    // rel 为空 = 根目录直接是 skill；skills/ 子目录为旧布局兼容
    return scanRoot(central, [
      { id: 'central', rel: '' },
      { id: 'central', rel: 'skills' },
    ]);
  }
  if (side === 'project') {
    if (!explicitPath) throw badInput('project 路径不能为空');
    const root = resolve(String(explicitPath));
    const list = await scanRoot(root, ADAPTERS.map((a) => ({ id: a.id, rel: a.dir })));
    // 附带"该 skill 存在于哪些平台（适配器）"的信息，供平台小按钮渲染
    for (const s of list) {
      const platforms = [];
      for (const a of ADAPTERS) {
        const p = join(root, a.dir, s.name);
        if (await pathExists(p)) platforms.push({ id: a.id, dir: a.dir, linkType: await detectLinkType(p) });
      }
      s.platforms = platforms;
      if (platforms.length) s.adapter = platforms[0].id;
    }
    return list;
  }
  throw badInput('side 必须是 central 或 project');
}

async function scanRoot(root, locations) {
  const out = [];
  const seen = new Set();
  for (const loc of locations) {
    const dir = loc.rel ? join(root, loc.rel) : root;
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.name || e.name.startsWith('.')) continue;
      if (loc.rel === '' && ADAPTERS.some((a) => e.name === a.dir.split('/')[0])) continue;
      if (loc.rel === '' && e.name === 'skills') continue;
      const skillDir = join(dir, e.name);
      // 用 lstat 判存在：悬空链接（目标已删）也要走进来，才能被识别与删除
      const lst = await fsp.lstat(skillDir).catch(() => null);
      if (!lst) continue;
      if (!lst.isDirectory() && !lst.isSymbolicLink()) continue;
      if (seen.has(e.name)) continue;
      seen.add(e.name);
      const info = await readSkill(skillDir);
      if (!info) {
        // SKILL.md 读不到但本身是链接：典型为悬空链接（中心侧已删）——仍列出，便于删除
        const lt = lst.isSymbolicLink() ? 'symlink' : await detectLinkType(skillDir);
        if (lt) {
          out.push({
            name: e.name,
            description: '(链接目标缺失，可删除)',
            dir: skillDir,
            md5: '',
            lastModified: '',
            linkType: lt,
            adapter: loc.id,
          });
        }
        continue;
      }
      info.adapter = loc.id;
      out.push(info);
    }
  }
  return out;
}

// 链接创建与类型识别见 core/link.js；目录树差异见 core/fstree.js。

async function findProjectSkillDir(projRoot, name) {
  for (const a of ADAPTERS) {
    const p = join(projRoot, a.dir, name);
    if (await exists(p)) return p;
  }
  return null;
}

// 项目内落点：--adapter 指定 > 第一个已存在的适配器目录 > .claude/skills
async function pickAdapterDir(projRoot, adapterId) {
  if (adapterId) {
    const a = ADAPTERS.find((x) => x.id === adapterId);
    if (!a) throw badInput('未知 adapter: ' + adapterId);
    return a.dir;
  }
  for (const a of ADAPTERS) {
    if (await exists(join(projRoot, a.dir))) return a.dir;
  }
  return '.claude/skills';
}

// ─── 同步操作 ──────────────────────────────────────────────────────

// 中心 -> 项目
export async function syncSkill({ name, project, mode, adapter, force }) {
  name = assertSafeName(name);
  const central = await centralPath();
  const src = await centralSkillDir(central, name);
  if (!src) throw notFound('中心仓库不存在该 skill: ' + name);
  if (!project) throw badInput('project 不能为空');
  const projRoot = resolve(String(project));

  const settings = await getSettings();
  const m = mode === 'copy' || mode === 'symlink' ? mode : settings.skillSyncMode;
  // 未指定平台时用设置里的默认平台（defaultPlatform / platforms[0]）
  const adapterId = adapter || settings.defaultPlatform || settings.platforms[0] || 'claude-code';
  const dst = join(projRoot, await pickAdapterDir(projRoot, adapterId), name);

  // 已是指向 src 的链接：天然一致，跳过
  const lt = await detectLinkType(dst);
  if (lt) {
    const target = await fsp.readlink(dst).catch(() => null);
    if (target) {
      const absT = isAbsolute(target) ? target : resolve(dirname(dst), target);
      if (await sameRealPath(absT, src)) return { status: 'ok', skipped: true, mode: m, linkType: lt, path: dst };
    }
  }

  // 目标为实体且内容有差异：冲突（除非 force）
  if (await exists(dst)) {
    const files = await diffTrees(src, dst);
    if (files.length && !force) {
      return { status: 'conflict', mode: m, files, path: dst };
    }
  }

  let linkResult = null;
  if (m === 'symlink') {
    linkResult = await createSkillLink(src, dst);
    if (linkResult.ok) {
      return { status: 'ok', mode: 'symlink', linkType: linkResult.linkType, path: dst };
    }
    // 链接失败 -> 降级复制，安装不因权限中断
  }

  if (await exists(dst)) {
    await fsp.rm(dst, { recursive: true, force: true });
  }
  await fsp.cp(src, dst, { recursive: true, dereference: true, force: true });
  return {
    status: 'ok',
    mode: 'copy',
    path: dst,
    degraded: m === 'symlink',
    degradedReason: linkResult && !linkResult.ok ? linkResult.error : undefined,
  };
}

// 项目 -> 中心
export async function pushSkill({ name, project, force }) {
  name = assertSafeName(name);
  if (!project) throw badInput('project 不能为空');
  const central = await centralPath();
  const src = await findProjectSkillDir(resolve(String(project)), name);
  if (!src) throw notFound('项目中未找到 skill: ' + name);

  const lt = await detectLinkType(src);
  if (lt) {
    return { status: 'ok', skipped: true, linkType: lt, reason: '项目侧为链接，与中心实时一致' };
  }

  const dst = join(central, name); // 中心根目录直接是 skill
  if (await exists(dst)) {
    const files = await diffTrees(dst, src);
    if (files.length && !force) {
      return { status: 'conflict', files, path: dst };
    }
    await fsp.rm(dst, { recursive: true, force: true });
  }
  await fsp.mkdir(dirname(dst), { recursive: true });
  await fsp.cp(src, dst, { recursive: true, dereference: true, force: true });
  return { status: 'ok', mode: 'copy', path: dst };
}

// 链接 -> 实体目录（物化）
export async function materializeSkill({ name, project }) {
  name = assertSafeName(name);
  if (!project) throw badInput('project 不能为空');
  const dst = await findProjectSkillDir(resolve(String(project)), name);
  if (!dst) throw notFound('项目中未找到 skill: ' + name);

  const lt = await detectLinkType(dst);
  if (!lt) return { converted: false, message: '已是实体文件' };

  const target = await fsp.readlink(dst);
  const absT = isAbsolute(target) ? target : resolve(dirname(dst), target);
  await fsp.rm(dst, { force: true });
  await fsp.cp(absT, dst, { recursive: true, dereference: true, force: true });
  return { converted: true, source: absT };
}

// 冲突详情：逐文件 md5 + 文本 diff
export async function skillConflict({ name, project }) {
  name = assertSafeName(name);
  if (!project) throw badInput('project 不能为空');
  const central = await centralPath();
  const src = await centralSkillDir(central, name);
  if (!src) throw notFound('中心仓库不存在该 skill: ' + name);
  const dst = await findProjectSkillDir(resolve(String(project)), name);
  if (!dst) throw notFound('项目中未找到 skill: ' + name);

  const files = await diffTrees(src, dst);
  for (const f of files) {
    if (f.side === 'only-central') continue;
    if (f.side === 'both-differ') {
      const aAbs = join(src, f.file);
      const bAbs = join(dst, f.file);
      const [aText, bText] = await Promise.all([
        fsp.readFile(aAbs, 'utf8').catch(() => ''),
        fsp.readFile(bAbs, 'utf8').catch(() => ''),
      ]);
      if (aText.length + bText.length < 512 * 1024) {
        f.diff = unifiedDiff(aText, bText, 'central/' + f.file, 'project/' + f.file);
      }
    }
  }
  return { name, centralDir: src, projectDir: dst, files };
}

// 冲突解决：按文件选侧（central 覆盖项目 / project 覆盖中心）
export async function applySkillSide({ name, project, file, side }) {
  name = assertSafeName(name);
  // skill 目录下只允许单层文件，但必须允许 .gitignore 这类前导点文件
  file = assertSafeRelPath(file, { label: '文件路径', allowSubdir: false });
  if (!project) throw badInput('project 不能为空');
  const central = await centralPath();
  const srcDir = (await centralSkillDir(central, name)) || join(central, name);
  const dst = await findProjectSkillDir(resolve(String(project)), name);
  if (!dst) throw notFound('项目中未找到 skill: ' + name);

  if (side === 'central') {
    await fsp.cp(join(srcDir, file), join(dst, file), { force: true });
    return { ok: true, side, file };
  }
  if (side === 'project') {
    await fsp.cp(join(dst, file), join(srcDir, file), { force: true });
    return { ok: true, side, file };
  }
  throw badInput('side 必须是 central 或 project');
}

// ─── 平台开关（项目侧：把 skill 提供给/撤销于某个平台） ──────────────

// 查询某个 skill 在各平台（适配器）下的存在形态
export async function platformStatus({ name, project } = {}) {
  name = assertSafeName(name);
  if (!project) throw badInput('project 不能为空');
  const projRoot = resolve(String(project));
  const out = [];
  for (const a of ADAPTERS) {
    const p = join(projRoot, a.dir, name);
    const on = await pathExists(p);
    out.push({ id: a.id, name: a.name, dir: a.dir, on, linkType: on ? await detectLinkType(p) : '' });
  }
  return { name, project: projRoot, platforms: out };
}

// 打开/关闭某个平台：打开=同步到该适配器目录；关闭=仅移除该适配器下的副本/链接
export async function setPlatform({ name, project, adapter, enabled, mode, force } = {}) {
  name = assertSafeName(name);
  if (!project) throw badInput('project 不能为空');
  const a = ADAPTERS.find((x) => x.id === adapter);
  if (!a) throw badInput('未知平台: ' + adapter);
  const projRoot = resolve(String(project));
  const dst = join(projRoot, a.dir, name);

  if (enabled) {
    // 优先走中心；中心没有该 skill（或未设置中心）时，从项目内旁支本地创建，不再强依赖中心
    const central = await centralPath().catch(() => '');
    const centralDir = central ? await centralSkillDir(central, name) : null;
    if (centralDir) {
      const r = await syncSkill({ name, project: projRoot, adapter: a.id, mode, force });
      return { ...r, platform: a.id };
    }
    const src = await findProjectSkillDir(projRoot, name);
    if (!src) throw notFound(`中心与项目中都不存在该 skill: ${name}`);
    if (await sameRealPath(src, dst)) return { status: 'ok', skipped: true, platform: a.id };

    if (await pathExists(dst)) {
      const ltDst = await detectLinkType(dst);
      if (ltDst) {
        const t = await fsp.readlink(dst).catch(() => null);
        const absT = t ? (isAbsolute(t) ? t : resolve(dirname(dst), t)) : '';
        if (await sameRealPath(absT, src)) return { status: 'ok', skipped: true, platform: a.id, linkType: ltDst };
      } else {
        const files = await diffTrees(dst, src);
        if (files.length && !force) return { status: 'conflict', platform: a.id, files, path: dst };
      }
      await fsp.rm(dst, { recursive: true, force: true });
    }
    await fsp.mkdir(dirname(dst), { recursive: true });
    // 链接指向旁支的最终实体（realpath），避免 junction 套 junction
    const realSrc = await fsp.realpath(src).catch(() => src);
    if ((mode === 'copy' ? 'copy' : 'symlink') === 'symlink') {
      const r = await createSkillLink(realSrc, dst);
      if (r.ok) return { status: 'ok', mode: 'symlink', linkType: r.linkType, platform: a.id, from: 'sibling' };
    }
    await fsp.cp(realSrc, dst, { recursive: true, dereference: true, force: true });
    return { status: 'ok', mode: 'copy', platform: a.id, from: 'sibling' };
  }
  if (!(await pathExists(dst))) {
    return { status: 'ok', skipped: true, platform: a.id, reason: '该平台本就没有此 skill' };
  }
  // 实体平台：若移除后项目将没有任何实体、且没有可物化的软链接，则阻止（保证至少一个实体）
  const ltOff = await detectLinkType(dst);
  if (!ltOff) {
    const rest = await scanProjectSkillsWithShape(projRoot);
    const restReal = rest.filter((x) => !x.linkType && x.path !== dst);
    const restLinks = rest.filter((x) => x.linkType && x.path !== dst);
    if (!restReal.length && !restLinks.length) {
      return {
        status: 'blocked',
        platform: a.id,
        reason: '项目内已无其他实体 skill，也没有可转换的软链接；删除将导致没有任何实体，已阻止（请从中心同步或推送到中心后再操作）',
      };
    }
  }
  await fsp.rm(dst, { recursive: true, force: true });
  const anchor = ltOff ? null : await ensureRealAnchor(projRoot, name);
  return { status: 'ok', removed: true, platform: a.id, path: dst, anchor };
}

// ─── 多选比较（中心 vs 项目） ────────────────────────────────────────

export async function compareSkills({ central, project, names } = {}) {
  if (!project) throw badInput('project 不能为空');
  const centralRoot = central ? resolve(String(central)) : await centralPath();
  const projRoot = resolve(String(project));

  const cs = await listSkills('central', centralRoot);
  const ps = await listSkills('project', projRoot);
  const filter = names && names.length ? new Set(names) : null;

  const merged = new Map();
  for (const s of cs) merged.set(s.name, { name: s.name, central: s });
  for (const s of ps) {
    const e = merged.get(s.name) || { name: s.name };
    e.project = s;
    merged.set(s.name, e);
  }

  const rows = [];
  for (const e of [...merged.values()].sort((x, y) => x.name.localeCompare(y.name))) {
    if (filter && !filter.has(e.name)) continue;
    let state;
    if (e.central && e.project) {
      const linked = (e.project.platforms || []).some((p) => p.linkType);
      state = linked ? 'linked' : e.central.md5 === e.project.md5 ? 'same' : 'differ';
    } else if (e.central) state = 'only-central';
    else state = 'only-project';
    rows.push({
      name: e.name,
      state,
      description: (e.central || e.project).description,
      centralMd5: e.central ? e.central.md5 : '',
      projectMd5: e.project ? e.project.md5 : '',
      platforms: e.project ? e.project.platforms || [] : [],
    });
  }

  const count = (s) => rows.filter((r) => r.state === s).length;
  return {
    central: centralRoot,
    project: projRoot,
    summary: {
      total: rows.length,
      same: count('same'),
      linked: count('linked'),
      differ: count('differ'),
      onlyCentral: count('only-central'),
      onlyProject: count('only-project'),
    },
    rows,
  };
}

// ─── 实体锚点兜底：项目内至少保留一个实体（非链接）skill ─────────────
// 扫描项目里所有 skill 目录（含形态）；realCount = 实体个数
async function scanProjectSkillsWithShape(projRoot) {
  const out = [];
  for (const a of ADAPTERS) {
    const dir = join(projRoot, a.dir);
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      // 注意：junction 在 readdir 的 dirent 上 isDirectory 可能为 false，必须用 stat（跟随链接）
      const st = await fsp.stat(p).catch(() => null);
      if (!st || !st.isDirectory()) continue;
      if (!(await exists(join(p, 'SKILL.md')))) continue;
      out.push({ name: e.name, platform: a.id, path: p, linkType: await detectLinkType(p) });
    }
  }
  return out;
}

// 若项目里已无实体 skill，则自动物化一个软链接 skill 作为新的实体锚点。
// preferOtherOf：尽量物化"其他 skill"的链接，而非指定 skill 自己的。
async function ensureRealAnchor(projRoot, preferOtherOf = '') {
  const all = await scanProjectSkillsWithShape(projRoot);
  const real = all.filter((s) => !s.linkType);
  if (real.length) return { converted: null, realCount: real.length };

  const links = all.filter((s) => s.linkType);
  if (!links.length) return { converted: null, realCount: 0 };

  links.sort((a, b) => Number(a.name === preferOtherOf) - Number(b.name === preferOtherOf));
  const candidate = links[0];
  const target = await fsp.readlink(candidate.path);
  const absT = isAbsolute(target) ? target : resolve(dirname(candidate.path), target);
  await fsp.rm(candidate.path, { force: true });
  await fsp.cp(absT, candidate.path, { recursive: true, dereference: true, force: true });
  return { converted: { name: candidate.name, platform: candidate.platform, source: absT }, realCount: 1 };
}

// 从项目里删除一个 skill（移除所有平台目录下的副本与链接）；
// 若删掉的是最后一个实体，会先自动物化其他软链接兜底，保证项目内至少一个实体。
export async function removeProjectSkill({ name, project } = {}) {
  name = assertSafeName(name);
  if (!project) throw badInput('project 不能为空');
  const projRoot = resolve(String(project));
  const removed = [];
  for (const a of ADAPTERS) {
    const p = join(projRoot, a.dir, name);
    if (await pathExists(p)) {
      const lt = await detectLinkType(p);
      removed.push({ platform: a.id, path: p, linkType: lt });
    }
  }
  if (!removed.length) return { status: 'ok', removed: [], anchor: null, reason: '项目中没有该 skill' };

  // 先删，再检查：若删掉的是实体且项目里已无实体，自动物化其他软链接兜底
  const removedReal = removed.some((r) => !r.linkType);
  for (const r of removed) {
    await fsp.rm(r.path, { recursive: true, force: true });
  }
  const anchor = removedReal ? await ensureRealAnchor(projRoot, name) : null;
  return { status: 'ok', removed, anchor };
}
