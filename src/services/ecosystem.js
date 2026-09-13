// 生态导入 service：从浏览器插件的 native host 状态目录读取进程记录，
// 提取其中的项目目录（workDir），把 git 仓库与 skills 导入 nx-rh。
// 数据源：~/.bro_chat_native_host/（可用 NX_RH_BROCHAT_DIR 覆盖，供测试）
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import fsp from 'node:fs/promises';
import { loadStore } from '../core/store.js';
import { addRepo, isGitRepoPath } from './repos.js';
import {
  ADAPTERS,
  createSkillLink,
  diffTrees,
  getCentralPath,
  listSkills,
  pushSkill,
  setCentralPath,
} from './skills.js';

const PROCESS_STATE_FILES = [
  'processes.json',
  'conpty_processes.json',
  'pty_processes.json',
  'window_processes.json',
];

export function broChatDir() {
  return resolve(process.env.NX_RH_BROCHAT_DIR || join(homedir(), '.bro_chat_native_host'));
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJsonSafe(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

// 从 workDir 向上找 git 根（进程目录常是仓库子目录）
async function findGitRoot(start, maxUp = 5) {
  let cur = resolve(start);
  for (let i = 0; i <= maxUp; i++) {
    if (await isGitRepoPath(cur)) return cur;
    const parent = resolve(cur, '..');
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

// 目录是否含 skill 目录（任一适配器目录存在即视为可导入源）
async function skillDirsIn(projRoot) {
  const dirs = [];
  for (const a of ADAPTERS) {
    if (await exists(join(projRoot, a.dir))) dirs.push(a.dir);
  }
  return dirs;
}

// 扫描 native host 状态目录，返回可读概览（不改任何数据）
export async function ecoScan() {
  const dir = broChatDir();
  const result = {
    dir,
    exists: await exists(dir),
    files: [],
    workDirs: [],
    envSnapshots: [],
    logCount: 0,
    manifest: null,
  };
  if (!result.exists) return result;

  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    const abs = join(dir, e.name);
    const st = await fsp.stat(abs).catch(() => null);
    result.files.push({
      name: e.name,
      size: st ? st.size : 0,
      mtime: st ? st.mtime.toISOString() : '',
      kind: PROCESS_STATE_FILES.includes(e.name)
        ? 'process'
        : e.name.startsWith('env_snapshot_')
          ? 'env'
          : 'other',
    });
  }
  result.files.sort((a, b) => a.name.localeCompare(b.name));

  // 进程状态文件 -> workDir 集合
  const seen = new Map(); // lowerPath -> original
  for (const fname of PROCESS_STATE_FILES) {
    const data = await readJsonSafe(join(dir, fname));
    if (!Array.isArray(data)) continue;
    for (const item of data) {
      const wd = item && typeof item.workDir === 'string' ? item.workDir.trim() : '';
      if (!wd) continue;
      const abs = resolve(wd);
      const key = abs.toLowerCase();
      if (!seen.has(key)) seen.set(key, abs);
    }
  }

  for (const abs of seen.values()) {
    const gitRoot = await findGitRoot(abs);
    // skill 目录可能在 workDir 本身，也可能在它的 git 根（进程目录常是仓库子目录）
    const roots = gitRoot && gitRoot !== abs ? [abs, gitRoot] : [abs];
    const skillDirs = [];
    const skillRoots = [];
    for (const r of roots) {
      const dirs = await skillDirsIn(r);
      if (dirs.length) {
        skillRoots.push(r);
        for (const d of dirs) if (!skillDirs.includes(d)) skillDirs.push(d);
      }
    }
    result.workDirs.push({
      path: abs,
      exists: await exists(abs),
      isGit: !!gitRoot,
      gitRoot: gitRoot || '',
      skillDirs,
      skillRoots,
    });
  }
  result.workDirs.sort((a, b) => a.path.localeCompare(b.path));

  // skill 候选项目：workDir + git 根 + 实际含 skill 目录的根，去重
  const projSet = new Map();
  for (const w of result.workDirs) {
    for (const p of [w.path, w.gitRoot, ...w.skillRoots]) {
      if (!p) continue;
      projSet.set(p.toLowerCase(), p);
    }
  }
  result.skillProjects = [...projSet.values()];

  // env 快照（摘要 + 其中的路径，用于按需导入）
  const envPathSet = new Map();
  for (const f of result.files.filter((x) => x.kind === 'env')) {
    const data = await readJsonSafe(join(dir, f.name));
    if (!data) continue;
    if (data.timestamp) result.envSnapshots.push({ file: f.name, timestamp: data.timestamp });
    for (const list of [data.userPath, data.systemPath]) {
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        const p = item && typeof item.path === 'string' ? item.path.trim() : '';
        if (!p || !isAbsolute(p)) continue; // 跳过被截断的条目（如 "C"、"\Windows\..."）
        if (!envPathSet.has(p.toLowerCase())) envPathSet.set(p.toLowerCase(), resolve(p));
      }
    }
  }
  result.envPaths = [...envPathSet.values()];

  const logDir = join(dir, 'logs');
  result.logCount = (await fsp.readdir(logDir).catch(() => [])).length;

  result.manifest = await readJsonSafe(join(dir, 'com.brochat.prompts_editor.json'));
  return result;
}

// 导入 git 仓库：workDir（含向上找到的 git 根）-> nx-rh repos
// includeEnv: 同时扫描 env 快照里的 PATH 目录（自动只看真实存在的 git 仓库）
export async function ecoImportRepos({ paths, includeEnv } = {}) {
  const scan = await ecoScan();
  let candidates;
  if (paths && paths.length) {
    candidates = paths.map(resolve);
  } else {
    candidates = scan.workDirs.map((w) => w.path);
    if (includeEnv) candidates = candidates.concat(scan.envPaths);
  }
  const out = { added: [], existing: [], nonGit: [], scanned: candidates.length };

  const registered = new Set((await loadStore()).repos.map((r) => r.path.toLowerCase()));
  for (const p of candidates) {
    if (!(await exists(p))) continue;
    const gitRoot = await findGitRoot(p);
    if (!gitRoot) {
      out.nonGit.push(p);
      continue;
    }
    if (registered.has(gitRoot.toLowerCase())) {
      out.existing.push(gitRoot);
      continue;
    }
    try {
      const repo = await addRepo({ path: gitRoot, tags: ['eco-import'] });
      out.added.push(repo);
      registered.add(gitRoot.toLowerCase());
    } catch {
      out.existing.push(gitRoot);
    }
  }
  return out;
}

// 单个 skill 安装进中心仓库（软链接或复制，含冲突处理）
async function installIntoCentral(central, name, srcDir, { mode, force }) {
  const dst = join(central, 'skills', name);
  if (!(await exists(dst))) {
    if (mode === 'symlink') {
      const r = await createSkillLink(srcDir, dst);
      if (r.ok) return { action: 'linked', name };
    }
    await fsp.mkdir(join(central, 'skills'), { recursive: true });
    await fsp.cp(srcDir, dst, { recursive: true, dereference: true, force: true });
    return { action: mode === 'symlink' ? 'copied-degraded' : 'copied', name };
  }
  const files = await diffTrees(dst, srcDir);
  if (!files.length) return { action: 'skipped', name };
  if (!force) return { action: 'conflict', name, files };
  await fsp.rm(dst, { recursive: true, force: true });
  if (mode === 'symlink') {
    const r = await createSkillLink(srcDir, dst);
    if (r.ok) return { action: 'linked', name, forced: true };
  }
  await fsp.cp(srcDir, dst, { recursive: true, dereference: true, force: true });
  return { action: 'copied', name, forced: true };
}

// 导入 skills：对每个项目目录同时识别两种布局
// - 中心式：{path}/skills/<name>/SKILL.md（作为源装到中心）
// - 项目式：{path}/<adapter 目录>/<name>/SKILL.md（用 pushSkill 推到中心）
export async function ecoImportSkills({ paths, mode, force, centralPath } = {}) {
  const scan = await ecoScan();
  const projects = paths && paths.length ? paths.map(resolve) : scan.skillProjects;

  // 先探测是否有可导入的 skill 源；没有就直接返回（不要求配置中心仓库）
  const sources = [];
  for (const p of projects) {
    if (await exists(join(p, 'skills'))) {
      for (const s of await listSkills('central', p).catch(() => [])) sources.push({ p, s, layout: 'central' });
    }
    for (const s of await listSkills('project', p).catch(() => [])) {
      sources.push({ p, s, layout: 'project' });
    }
  }
  if (!sources.length) {
    return { central: '', empty: true, projects, linked: [], copied: [], pushed: [], skipped: [], conflicts: [], errors: [] };
  }

  if (centralPath) await setCentralPath(centralPath);
  const central = await getCentralPath();
  const m = mode === 'symlink' ? 'symlink' : 'copy';

  const out = { central, empty: false, projects, linked: [], copied: [], pushed: [], skipped: [], conflicts: [], errors: [] };
  for (const { p, s, layout } of sources) {
    try {
      if (layout === 'central') {
        const r = await installIntoCentral(central, s.name, s.dir, { mode: m, force: !!force });
        if (r.action === 'conflict') out.conflicts.push({ name: r.name, project: p, files: r.files });
        else if (r.action === 'skipped') out.skipped.push(r.name);
        else if (r.action === 'linked') out.linked.push(r.name);
        else out.copied.push(r.name);
        continue;
      }
      // 项目式布局
      if (s.linkType) {
        out.skipped.push(s.name + ' (链接)');
        continue;
      }
      const r = await pushSkill({ name: s.name, project: p, force: !!force });
      if (r.status === 'ok') out.pushed.push(s.name);
      else if (r.status === 'conflict') out.conflicts.push({ name: s.name, project: p, files: r.files });
      else out.skipped.push(s.name);
    } catch (err) {
      out.errors.push({ name: s.name, project: p, error: String((err && err.message) || err) });
    }
  }
  return out;
}
