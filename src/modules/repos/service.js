// 仓库登记 service：登记、CRUD、目录扫描。
// 本文件是业务真相源，不含任何传输层概念（不认识 argv，也不认识 HTTP）。
// 刻意不碰 git：只记录「这台机器上有哪些仓库、它们分别是什么」，
// 状态与读写交给 git 本身（面板做不好的东西不做，见 README）。
import { basename, join, resolve } from 'node:path';
import fsp from 'node:fs/promises';
import { loadStore, mutateStore, newId } from '../../core/store.js';
import { openPath } from '../../core/open.js';
import { badInput, notFound, conflict } from '../../core/errors.js';

function parseTags(tags) {
  if (Array.isArray(tags)) return tags.map((t) => String(t).trim()).filter(Boolean);
  if (typeof tags === 'string') return tags.split(',').map((t) => t.trim()).filter(Boolean);
  return [];
}

function normalizeRepoInput({ path, name, tags, notes, desc }) {
  const abs = resolve(String(path || ''));
  return {
    id: newId('r'),
    name: (name || basename(abs) || 'repo').trim(),
    path: abs,
    tags: parseTags(tags),
    desc: (desc || '').trim(),
    notes: (notes || '').trim(),
    addedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function listRepos() {
  return (await loadStore()).repos;
}

export async function addRepo(input) {
  if (!input || !input.path) throw badInput('path 不能为空');
  const repo = normalizeRepoInput(input);
  await mutateStore((s) => {
    if (s.repos.some((r) => r.path.toLowerCase() === repo.path.toLowerCase())) {
      throw conflict('该路径已登记: ' + repo.path);
    }
    s.repos.push(repo);
  });
  return repo;
}

export async function updateRepo(id, patch) {
  return mutateStore((s) => {
    const r = s.repos.find((x) => x.id === id);
    if (!r) throw notFound('repo 不存在: ' + id);
    if (patch.name !== undefined) r.name = String(patch.name).trim();
    if (patch.tags !== undefined) r.tags = parseTags(patch.tags);
    if (patch.desc !== undefined) r.desc = String(patch.desc).trim();
    if (patch.notes !== undefined) r.notes = String(patch.notes);
    if (patch.path !== undefined) {
      const abs = resolve(String(patch.path));
      // 改路径同样要防重复登记，否则两条记录指向同一目录，扫描时无法判断是否已登记
      if (s.repos.some((x) => x.id !== id && x.path.toLowerCase() === abs.toLowerCase())) {
        throw conflict('该路径已登记: ' + abs);
      }
      r.path = abs;
    }
    r.updatedAt = new Date().toISOString();
    return r;
  });
}

export async function removeRepo(id) {
  return mutateStore((s) => {
    const idx = s.repos.findIndex((x) => x.id === id);
    if (idx < 0) throw notFound('repo 不存在: ' + id);
    return s.repos.splice(idx, 1)[0];
  });
}

// id 或绝对路径均可定位（agent 场景常直接给路径）
export async function getRepo(idOrPath) {
  const s = await loadStore();
  let r = s.repos.find((x) => x.id === idOrPath);
  if (!r) {
    const p = resolve(idOrPath);
    r = s.repos.find((x) => x.path.toLowerCase() === p.toLowerCase());
  }
  if (!r) throw notFound('repo 不存在: ' + idOrPath);
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

// 含 .git（目录或文件——worktree / submodule 下是文件）即视为一个仓库根
async function hasGitDir(dir) {
  try {
    await fsp.stat(join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

// 扫描根目录下的 git 仓库。
// `dryRun` 时**只列出**（发现模式）：「看看这底下都有些什么仓库」和「把它们都收进来」
// 是两个动作，前者不该有任何副作用——agent 的探测步骤尤其不能顺手改状态。
export async function scanRepos(root, depth = 3, { dryRun = false } = {}) {
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

  const repos = (await loadStore()).repos;
  const byPath = new Map(repos.map((r) => [r.path.toLowerCase(), r]));
  const detail = found.map((p) => {
    const hit = byPath.get(p.toLowerCase());
    return { path: p, known: !!hit, name: hit ? hit.name : '' };
  });

  if (dryRun) {
    return {
      root: absRoot,
      dryRun: true,
      scanned: found.length,
      found: detail,
      added: [],
      skipped: detail.filter((x) => x.known).length,
    };
  }

  const added = [];
  for (const p of found) {
    try {
      added.push(await addRepo({ path: p }));
    } catch {
      // 已登记，跳过
    }
  }
  return {
    root: absRoot,
    dryRun: false,
    scanned: found.length,
    found: detail,
    added,
    skipped: detail.length - added.length,
  };
}

// 在系统文件管理器中打开（"操作 OS 方便"的最小切口）
export async function repoOpen(id) {
  const r = await getRepo(id);
  openPath(r.path);
  return { opened: r.path };
}
