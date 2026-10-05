// 状态桶（按主仓库 cwdScope 分桶）+ 主仓库定位 + 命名/指纹等底层件。
// 本模块所有 svc 文件的叶下层；工作树清单本身以 git 为准，store 只存 git 不知道的东西。
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import fsp from 'node:fs/promises';
import { loadStore, mutateStore } from '../../../core/store.js';
import { projectRoot, cwdScope } from '../../../core/paths.js';
import { isWorkTree, topLevel, gitCommonDir } from '../../../core/git.js';

// ---- 命名与默认配置 ----

// 描述 → 目录/分支段。中文等无拉丁字符时退化为带短码的 task 名，避免撞名。
export function slug(s) {
  const out = String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return out || 'task-' + Date.now().toString(36).slice(-4);
}

export function defaultConfig(mainPath) {
  return {
    branchPrefix: 'feature/',
    baseBranch: 'main',
    // 默认集中存放（ccswitch 形态）：主项目目录保持干净
    worktreeRoot: join(homedir(), '.nx-rh', 'worktrees', slug(basename(mainPath))),
  };
}

// ---- 主仓库定位（业务策略） ----

// 给定任意目录（主仓库或某个链接工作树），解析出主仓库信息。
export async function resolveMainRepoInfo(startDir = projectRoot()) {
  const startAbs = resolve(String(startDir) || process.cwd());
  if (!isWorkTree(startAbs)) {
    return { git: false, path: startAbs, top: startAbs, name: basename(startAbs), linked: false };
  }
  const topAbs = topLevel(startAbs) || startAbs;
  const commonRaw = gitCommonDir(startAbs);
  let mainAbs;
  if (!commonRaw || commonRaw === '.git') {
    mainAbs = topAbs;
  } else {
    const commonAbs = isAbsolute(commonRaw) ? commonRaw : resolve(startAbs, commonRaw);
    mainAbs = basename(commonAbs) === '.git' ? dirname(commonAbs) : topAbs;
  }
  return {
    git: true,
    path: mainAbs,
    top: topAbs,
    name: basename(mainAbs),
    linked: resolve(topAbs).toLowerCase() !== resolve(mainAbs).toLowerCase(),
  };
}

// ---- 状态桶 ----

export async function getBucket(startDir = projectRoot()) {
  const main = await resolveMainRepoInfo(startDir);
  const defaults = defaultConfig(main.path);
  if (!main.git) return { main, key: cwdScope(main.path), config: defaults, extensions: [] };

  const store = await loadStore();
  const bucket = store.worktreeState[cwdScope(main.path)];
  return {
    main,
    key: cwdScope(main.path),
    config: { ...defaults, ...(bucket?.config || {}) },
    extensions: Array.isArray(bucket?.extensions) ? bucket.extensions : [],
  };
}

export async function patchBucket(mainPath, fn) {
  const key = cwdScope(mainPath);
  return mutateStore((s) => {
    if (!s.worktreeState[key]) s.worktreeState[key] = { config: {}, extensions: [] };
    const b = s.worktreeState[key];
    b.config = { ...defaultConfig(mainPath), ...b.config };
    if (!Array.isArray(b.extensions)) b.extensions = [];
    return fn(b);
  });
}

// ---- 指纹（变更检测） ----

export async function statOrNull(p) {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

const WALK_FILE_CAP = 5000;

// 文件：小文件直接 sha256 内容；大文件退化为 size+mtime（读全量太贵）。
// 目录：对「相对路径:大小:mtime」清单取 sha256——新增/删除/改动都能反映，且不读文件内容。
export async function fingerprint(abs, st) {
  if (st.isFile()) {
    if (st.size <= 2 * 1024 * 1024) {
      const buf = await fsp.readFile(abs);
      return 'f:' + createHash('sha256').update(buf).digest('hex');
    }
    return 'f:l:' + [st.size, Math.round(st.mtimeMs)].join(':');
  }
  if (!st.isDirectory()) return 'u:' + [st.size, Math.round(st.mtimeMs)].join(':');

  const lines = [];
  let count = 0;
  let truncated = false;
  async function walk(dir, rel) {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (truncated) return;
      if (e.name === '.git') continue;
      const a = join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(a, r);
        continue;
      }
      if (!e.isFile()) continue;
      const s = await statOrNull(a);
      if (!s) continue;
      lines.push(`${r}:${s.size}:${Math.round(s.mtimeMs)}`);
      if (++count > WALK_FILE_CAP) {
        truncated = true;
        return;
      }
    }
  }
  await walk(abs, '');
  lines.sort();
  return 'd:' + createHash('sha256').update(lines.join('\n')).digest('hex') + (truncated ? '+trunc' : '');
}
