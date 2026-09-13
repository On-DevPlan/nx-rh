// Skill 管理 service：中心仓库 <-> 项目两侧的识别、软链接/复制同步、冲突分析。
// 链接算法移植自 vercel-labs/skills 的 installer.ts（junction/权限降级/自指防护），
// 业务语义（中心仓库 + 分组）延续 br_controller 的 fileops.go 设计。
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import fsp from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { loadStore, mutateStore } from '../core/store.js';
import { unifiedDiff } from '../core/diff.js';

// ─── 适配器表（平台适配） ───────────────────────────────────────────
// universal: 直接读 .agents/skills，无需为它建链接（vercel skills 的核心概念）
export const ADAPTERS = [
  { id: 'claude-code', name: 'Claude Code', dir: '.claude/skills', globalDir: '.claude/skills', universal: false },
  { id: 'agents', name: 'Universal (.agents)', dir: '.agents/skills', globalDir: '.agents/skills', universal: true },
  { id: 'cursor', name: 'Cursor', dir: '.cursor/skills', globalDir: '.cursor/skills', universal: false },
  { id: 'codex', name: 'Codex', dir: '.codex/skills', globalDir: '.codex/skills', universal: false },
  { id: 'gemini-cli', name: 'Gemini CLI', dir: '.gemini/skills', globalDir: '.gemini/skills', universal: false },
  { id: 'copilot', name: 'GitHub Copilot', dir: '.copilot/skills', globalDir: '.copilot/skills', universal: false },
  { id: 'windsurf', name: 'Windsurf', dir: '.windsurf/skills', globalDir: '.codeium/windsurf/skills', universal: false },
  { id: 'codebuddy', name: 'CodeBuddy', dir: '.codebuddy/skills', globalDir: '.codebuddy/skills', universal: false },
  { id: 'iflow-cli', name: 'iFlow CLI', dir: '.iflow/skills', globalDir: '.iflow/skills', universal: false },
];

export function listAdapters() {
  return ADAPTERS.map((a) => ({ ...a }));
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

function md5Of(buf) {
  return createHash('md5').update(buf).digest('hex');
}

// 名称安全校验：拒绝路径穿越（保留中文等合法命名，与 fileops.go 语义一致）
export function assertSafeName(name) {
  if (!name || typeof name !== 'string' || /[\\/]/.test(name) || name.includes('..') || name.startsWith('.')) {
    throw new Error('非法 skill 名称: ' + name);
  }
  return name;
}

// ─── 设置 ──────────────────────────────────────────────────────────

export async function getSettings() {
  return (await loadStore()).settings;
}

export async function updateSettings(patch) {
  return mutateStore((s) => {
    for (const k of ['skillCentralPath', 'skillSyncMode']) {
      if (patch[k] !== undefined) s.settings[k] = String(patch[k]);
    }
    if (s.settings.skillSyncMode !== 'copy') s.settings.skillSyncMode = 'symlink';
    return { ...s.settings };
  });
}

export async function getCentralPath() {
  const s = await loadStore();
  if (!s.settings.skillCentralPath) {
    throw new Error('未设置 skill 中心仓库路径（nx-rh skill central <path>）');
  }
  return resolve(s.settings.skillCentralPath);
}

export async function setCentralPath(path) {
  if (!path) throw new Error('path 不能为空');
  await updateSettings({ skillCentralPath: resolve(String(path)) });
  return { skillCentralPath: resolve(String(path)) };
}

// ─── SKILL.md 解析（与 fileops.go / gitimporter.go 同语义） ─────────

function parseFrontmatter(content) {
  const m = /^---\s*\n([\s\S]+?)\n---/.exec(content);
  if (!m) return { name: '', description: '' };
  const lines = m[1].split('\n');
  let name = '';
  for (const line of lines) {
    const nm = /^name:\s*(.+)$/.exec(line);
    if (nm) {
      name = nm[1].trim();
      break;
    }
  }
  return { name, description: parseDescription(lines) };
}

function parseDescription(lines) {
  for (let i = 0; i < lines.length; i++) {
    const m = /^description:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const value = m[1].trim();
    if (value && value !== '|' && value !== '>') return value;
    if (!value) return '';
    // 块标量：收集后续缩进行
    const block = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (!l) {
        block.push('');
        continue;
      }
      if (l[0] !== ' ' && l[0] !== '\t') break;
      block.push(stripIndent(l));
    }
    if (block.length) return block.join('\n').trim();
    return value;
  }
  return '';
}

function stripIndent(l) {
  if (l.startsWith('  ')) return l.slice(2);
  if (l.startsWith('\t')) return l.slice(1);
  return l.replace(/^[ \t]+/, '');
}

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

// 链接类型检测：symlink / junction（启发式与 fileops.go 一致）
async function detectLinkType(p) {
  const lst = await fsp.lstat(p).catch(() => null);
  if (!lst) return '';
  if (lst.isSymbolicLink()) return 'symlink';
  if (process.platform === 'win32' && lst.isDirectory()) {
    const st = await fsp.stat(p).catch(() => null);
    if (st && (lst.dev !== st.dev || lst.ino !== st.ino)) return 'junction';
  }
  return '';
}

// ─── 两侧扫描 ──────────────────────────────────────────────────────

export async function listSkills(side = 'central', explicitPath) {
  if (side === 'central') {
    const central = explicitPath ? resolve(explicitPath) : await getCentralPath();
    return scanRoot(central, [{ id: 'central', rel: 'skills' }]);
  }
  if (side === 'project') {
    const root = resolve(String(explicitPath || ''));
    if (!explicitPath) throw new Error('project 路径不能为空');
    return scanRoot(root, ADAPTERS.map((a) => ({ id: a.id, rel: a.dir })));
  }
  throw new Error('side 必须是 central 或 project');
}

async function scanRoot(root, locations) {
  const out = [];
  const seen = new Set();
  for (const loc of locations) {
    const dir = join(root, loc.rel);
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.name || e.name.startsWith('.')) continue;
      const skillDir = join(dir, e.name);
      const st = await fsp.stat(skillDir).catch(() => null);
      if (!st || !st.isDirectory()) continue;
      if (seen.has(e.name)) continue;
      seen.add(e.name);
      const info = await readSkill(skillDir);
      if (!info) continue;
      info.adapter = loc.id;
      out.push(info);
    }
  }
  return out;
}

// ─── 链接创建（移植 vercel-labs/skills installer.ts 的关键防护） ────

function samePath(a, b) {
  if (!a || !b) return false;
  const na = resolve(a);
  const nb = resolve(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

// 父目录本身是软链时，解析出"真实父目录 + 原文件名"，防止相对链接算错
async function resolveParentSymlinks(p) {
  const abs = resolve(p);
  try {
    return join(await fsp.realpath(dirname(abs)), basename(abs));
  } catch {
    return abs;
  }
}

export async function createSkillLink(target, linkPath) {
  try {
    const absT = resolve(target);
    const absL = resolve(linkPath);

    // 防自指：双方 realpath 相同视为已就绪（避免 rm -rf 删掉源）
    const realT = await fsp.realpath(absT).catch(() => absT);
    const realL = await fsp.realpath(absL).catch(() => absL);
    if (samePath(realT, realL)) return { ok: true, linkType: '', already: true };

    const realT2 = await resolveParentSymlinks(absT);
    const realL2 = await resolveParentSymlinks(absL);
    if (samePath(realT2, realL2)) return { ok: true, linkType: '', already: true };

    // 清理旧目标：链接只删本体，实体目录递归删除
    try {
      const st = await fsp.lstat(absL);
      if (st.isSymbolicLink()) await fsp.rm(absL, { force: true });
      else await fsp.rm(absL, { recursive: true, force: true });
    } catch {
      // ENOENT：目标不存在，直接创建
    }

    await fsp.mkdir(dirname(absL), { recursive: true });

    if (process.platform === 'win32') {
      // junction 不需要开发者模式/管理员；要求绝对目标
      await fsp.symlink(realT2, absL, 'junction');
      return { ok: true, linkType: 'junction' };
    }
    // POSIX：相对目标，整目录搬迁后链接仍有效
    const rel = relative(await resolveParentSymlinks(dirname(absL)), realT2);
    await fsp.symlink(rel, absL);
    return { ok: true, linkType: 'symlink' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── 目录树差异（fileops.go 只比 SKILL.md；这里逐文件 md5） ────────

async function walkFiles(root) {
  const files = new Map();
  async function walk(dir, rel) {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const abs = join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(abs, r);
      else if (e.isFile()) {
        const buf = await fsp.readFile(abs).catch(() => null);
        if (buf === null) continue;
        files.set(r, { abs, md5: md5Of(buf), size: buf.length });
      }
    }
  }
  await walk(root, '');
  return files;
}

export async function diffTrees(aRoot, bRoot) {
  const [a, b] = await Promise.all([walkFiles(aRoot), walkFiles(bRoot)]);
  const out = [];
  for (const [rel, fa] of a) {
    const fb = b.get(rel);
    if (!fb) out.push({ file: rel, side: 'only-central' });
    else if (fa.md5 !== fb.md5) out.push({ file: rel, side: 'both-differ' });
  }
  for (const [rel] of b) {
    if (!a.has(rel)) out.push({ file: rel, side: 'only-project' });
  }
  return out;
}

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
    if (!a) throw new Error('未知 adapter: ' + adapterId);
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
  const central = await getCentralPath();
  const src = join(central, 'skills', name);
  if (!(await exists(src))) throw new Error('中心仓库不存在该 skill: ' + name);
  if (!project) throw new Error('project 不能为空');
  const projRoot = resolve(String(project));

  const settings = await getSettings();
  const m = mode === 'copy' || mode === 'symlink' ? mode : settings.skillSyncMode;
  const dst = join(projRoot, await pickAdapterDir(projRoot, adapter), name);

  // 已是指向 src 的链接：天然一致，跳过
  const lt = await detectLinkType(dst);
  if (lt) {
    const target = await fsp.readlink(dst).catch(() => null);
    if (target) {
      const absT = isAbsolute(target) ? target : resolve(dirname(dst), target);
      if (samePath(absT, src)) return { status: 'ok', skipped: true, mode: m, linkType: lt, path: dst };
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
  if (!project) throw new Error('project 不能为空');
  const central = await getCentralPath();
  const src = await findProjectSkillDir(resolve(String(project)), name);
  if (!src) throw new Error('项目中未找到 skill: ' + name);

  const lt = await detectLinkType(src);
  if (lt) {
    return { status: 'ok', skipped: true, linkType: lt, reason: '项目侧为链接，与中心实时一致' };
  }

  const dst = join(central, 'skills', name);
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
  if (!project) throw new Error('project 不能为空');
  const dst = await findProjectSkillDir(resolve(String(project)), name);
  if (!dst) throw new Error('项目中未找到 skill: ' + name);

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
  if (!project) throw new Error('project 不能为空');
  const central = await getCentralPath();
  const src = join(central, 'skills', name);
  if (!(await exists(src))) throw new Error('中心仓库不存在该 skill: ' + name);
  const dst = await findProjectSkillDir(resolve(String(project)), name);
  if (!dst) throw new Error('项目中未找到 skill: ' + name);

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
  if (!file || /[\\/]/.test(file) || file.includes('..') || isAbsolute(file)) {
    throw new Error('非法文件路径: ' + file);
  }
  if (!project) throw new Error('project 不能为空');
  const central = await getCentralPath();
  const srcDir = join(central, 'skills', name);
  const dst = await findProjectSkillDir(resolve(String(project)), name);
  if (!dst) throw new Error('项目中未找到 skill: ' + name);

  if (side === 'central') {
    await fsp.cp(join(srcDir, file), join(dst, file), { force: true });
    return { ok: true, side, file };
  }
  if (side === 'project') {
    await fsp.cp(join(dst, file), join(srcDir, file), { force: true });
    return { ok: true, side, file };
  }
  throw new Error('side 必须是 central 或 project');
}
