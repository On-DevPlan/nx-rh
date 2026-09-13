// 仓库管理 service：登记、CRUD、目录扫描、git 状态与远端操作。
// 该层是 Web API 与 CLI 的共同底层——按钮与命令在这里汇合。
import { basename, join, resolve } from 'node:path';
import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { loadStore, mutateStore, newId } from '../core/store.js';
import { gitStatus, gitDiff, gitPull, gitPush, gitResolve } from '../core/git.js';

function parseTags(tags) {
  if (Array.isArray(tags)) return tags.map((t) => String(t).trim()).filter(Boolean);
  if (typeof tags === 'string') return tags.split(',').map((t) => t.trim()).filter(Boolean);
  return [];
}

function normalizeRepoInput({ path, name, tags, notes }) {
  const abs = resolve(String(path || ''));
  return {
    id: newId('r'),
    name: (name || basename(abs) || 'repo').trim(),
    path: abs,
    tags: parseTags(tags),
    notes: (notes || '').trim(),
    addedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function listRepos() {
  return (await loadStore()).repos;
}

export async function addRepo(input) {
  if (!input || !input.path) throw new Error('path 不能为空');
  const repo = normalizeRepoInput(input);
  await mutateStore((s) => {
    if (s.repos.some((r) => r.path.toLowerCase() === repo.path.toLowerCase())) {
      throw new Error('该路径已登记: ' + repo.path);
    }
    s.repos.push(repo);
  });
  return repo;
}

export async function updateRepo(id, patch) {
  return mutateStore((s) => {
    const r = s.repos.find((x) => x.id === id);
    if (!r) throw new Error('repo 不存在: ' + id);
    if (patch.name !== undefined) r.name = String(patch.name).trim();
    if (patch.tags !== undefined) r.tags = parseTags(patch.tags);
    if (patch.notes !== undefined) r.notes = String(patch.notes);
    if (patch.path !== undefined) r.path = resolve(String(patch.path));
    r.updatedAt = new Date().toISOString();
    return r;
  });
}

export async function removeRepo(id) {
  return mutateStore((s) => {
    const idx = s.repos.findIndex((x) => x.id === id);
    if (idx < 0) throw new Error('repo 不存在: ' + id);
    return s.repos.splice(idx, 1)[0];
  });
}

// id 或绝对路径均可定位（agent 场景常直接给路径）
async function getRepo(idOrPath) {
  const s = await loadStore();
  let r = s.repos.find((x) => x.id === idOrPath);
  if (!r) {
    const p = resolve(idOrPath);
    r = s.repos.find((x) => x.path.toLowerCase() === p.toLowerCase());
  }
  if (!r) throw new Error('repo 不存在: ' + idOrPath);
  return r;
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'target',
  '__pycache__',
  '.venv',
  'vendor',
  'bower_components',
  '.nx-rh',
  'AppData',
]);

async function hasGitDir(dir) {
  try {
    await fsp.stat(join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

// 供 ecosystem 等其他 service 复用
export { hasGitDir as isGitRepoPath };

// 扫描根目录下的 git 仓库并登记（跳过依赖类大目录，允许 .claude 等点目录）
export async function scanRepos(root, depth = 3) {
  const absRoot = resolve(String(root || ''));
  const found = [];

  async function walk(dir, d) {
    if (await hasGitDir(dir)) found.push(dir);
    if (d <= 0) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue;
      await walk(join(dir, e.name), d - 1);
    }
  }

  await walk(absRoot, depth);
  const added = [];
  for (const p of found) {
    try {
      added.push(await addRepo({ path: p }));
    } catch {
      // 已登记，跳过
    }
  }
  return { root: absRoot, scanned: found.length, added };
}

export async function repoStatus(id) {
  if (id) {
    const r = await getRepo(id);
    return [{ ...r, git: await gitStatus(r.path) }];
  }
  const s = await loadStore();
  return Promise.all(
    s.repos.map(async (r) => ({ ...r, git: await gitStatus(r.path) }))
  );
}

export async function repoDiff(id, file) {
  const r = await getRepo(id);
  return gitDiff(r.path, file);
}

export async function repoPull(id) {
  const r = await getRepo(id);
  return gitPull(r.path);
}

export async function repoPush(id) {
  const r = await getRepo(id);
  return gitPush(r.path);
}

export async function repoResolve(id, file, side) {
  const r = await getRepo(id);
  return gitResolve(r.path, file, side);
}

// 在系统文件管理器中打开（"操作 OS 方便"的最小切口）
export async function repoOpen(id) {
  const r = await getRepo(id);
  const plat = process.platform;
  try {
    if (plat === 'win32') spawn('explorer', [r.path], { detached: true, stdio: 'ignore' }).unref();
    else if (plat === 'darwin') spawn('open', [r.path], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [r.path], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // 打开失败不视为错误
  }
  return { opened: r.path };
}
