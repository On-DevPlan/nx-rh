// 工作树模块 service：业务真相源。
// 不认识 argv 也不认识 HTTP——输入都是普通对象，输出都是普通数据。
//
// 与 repos 模块的边界：repos 仍只登记仓库、不碰 git；**本模块独占 git-worktree
// 操作**（worktree add/remove/rebase 等），不做通用的 status/diff/pull/push。
// 工作树清单以 git 为唯一真相，store 只登记 git 不知道的东西：
//   - 扩展文件（.gitignore 里那些不会被 worktree 带走的文件）的全路径与指纹
//   - 模块配置（分支前缀 / 工作树根 / 基础分支 / 同步方式）
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import fsp from 'node:fs/promises';
import { loadStore, mutateStore, newId } from '../../core/store.js';
import { projectRoot, cwdScope } from '../../core/paths.js';
import { badInput, blocked, conflict, external, notFound } from '../../core/errors.js';
import { openPath } from '../../core/open.js';
import {
  aheadBehind,
  branchExists,
  checkIgnore,
  currentBranch,
  git,
  gitCommonDir,
  isDirty,
  isWorkTree,
  parseWorktreePorcelain,
  revParse,
  topLevel,
  worktreePorcelain,
} from '../../core/git.js';
import { concreteEntries, ignoreKey, parseGitignore } from '../../core/gitignore.js';

// ---- 命名与默认配置 ----

// 描述 → 目录/分支段。中文等无拉丁字符时退化为带短码的 task 名，避免撞名。
function slug(s) {
  const out = String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return out || 'task-' + Date.now().toString(36).slice(-4);
}

function defaultConfig(mainPath) {
  return {
    branchPrefix: 'feature/',
    baseBranch: 'main',
    // 默认集中存放（ccswitch 形态）：主项目目录保持干净
    worktreeRoot: join(homedir(), '.nx-rh', 'worktrees', slug(basename(mainPath))),
    syncMode: 'copy', // 跨平台最稳；symlink 在 Windows 文件链接需权限
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

// ---- 状态桶（按主仓库 cwdScope 分桶） ----

async function getBucket(startDir = projectRoot()) {
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

async function patchBucket(mainPath, fn) {
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

async function statOrNull(p) {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

const WALK_FILE_CAP = 5000;

// 文件：小文件直接 sha256 内容；大文件退化为 size+mtime（读全量太贵）。
// 目录：对「相对路径:大小:mtime」清单取 sha256——新增/删除/改动都能反映，且不读文件内容。
async function fingerprint(abs, st) {
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

// ---- 工作树清单（git 真相 + 富状态） ----

export async function listWorktrees({ base, startDir } = {}) {
  const bucket = await getBucket(startDir);
  if (!bucket.main.git) return { main: bucket.main, config: bucket.config, worktrees: [] };

  const records = parseWorktreePorcelain(worktreePorcelain(bucket.main.path));
  const baseRef = base || bucket.config.baseBranch;
  const worktrees = [];

  for (const r of records) {
    const isMain = r.path === bucket.main.path;
    const name = isMain ? 'main' : basename(r.path);
    const dirty = isDirty(r.path);
    let counts = { ahead: null, behind: null };
    if (r.branch && baseRef) counts = aheadBehind(r.path, baseRef);

    let extMissing = 0;
    for (const e of bucket.extensions) {
      if (e.outside) continue;
      if ((await statOrNull(join(r.path, e.relPath))) === null) extMissing++;
    }

    worktrees.push({
      path: r.path,
      name,
      branch: r.branch,
      head: r.head,
      isMain,
      detached: r.detached,
      locked: r.locked,
      dirty,
      ahead: counts.ahead,
      behind: counts.behind,
      extMissing,
    });
  }
  return { main: bucket.main, config: bucket.config, worktrees };
}

function matchWorktree(worktrees, ref) {
  const r = String(ref || '').trim();
  if (!r) return null;
  const norm = (p) => resolve(p).toLowerCase();
  let hit = worktrees.find((w) => w.name === r);
  if (!hit) hit = worktrees.find((w) => norm(w.path) === norm(r));
  if (!hit) hit = worktrees.find((w) => w.branch === r);
  if (!hit) hit = worktrees.find((w) => basename(w.path) === r);
  if (!hit && r === '.') hit = worktrees.find((w) => w.isMain === false) || null;
  return hit || null;
}

export async function getWorktree(ref) {
  const { main, worktrees } = await listWorktrees();
  if (!main.git) throw notFound('不是 git 仓库，没有工作树: ' + main.path);
  const wt = matchWorktree(worktrees, ref);
  if (!wt) throw notFound(`工作树不存在: ${ref}（用 nx-rh wt list 查看）`);
  wt.log = git(wt.path, ['log', '--oneline', '-n', '8'], { allowFail: true }).stdout.trimEnd();
  wt.extensions = await inspectAt(wt.path);
  return wt;
}

// ---- 创建 / 挂载 / 移除 / 切换 / 打开 ----

export async function addWorktree(input) {
  const description = String(input.description ?? '').trim();
  if (!description) {
    throw badInput('用法: nx-rh wt add <描述> [--name N] [--base B] [--root R] —— 描述不能为空');
  }
  const { main, config } = await getBucket();
  if (!main.git) throw blocked('当前目录不是 git 仓库: ' + main.path);

  const session = slug(input.name || description);
  const branch = config.branchPrefix + session;
  const root = resolve(String(input.root || config.worktreeRoot));
  const target = join(root, session);
  const baseRef = String(input.base || config.baseBranch || '').trim();

  if ((await statOrNull(target)) !== null) {
    throw conflict(`目标目录已存在: ${target}（换 --name，或强制用 --force）`);
  }
  if (branch && branchExists(main.path, branch)) {
    throw conflict(`分支已存在: ${branch}（用 nx-rh wt checkout ${branch} 挂成工作树）`);
  }

  await fsp.mkdir(root, { recursive: true });
  const args = ['worktree', 'add'];
  if (input.force) args.push('--force');
  if (branch) args.push('-b', branch);
  args.push(target);
  if (baseRef) args.push(baseRef);
  git(main.path, args);

  return { status: 'ok', name: session, branch: branch || null, path: target, cd: target };
}

export async function checkoutWorktree(input) {
  const branch = String(input.branch ?? '').trim();
  if (!branch) throw badInput('用法: nx-rh wt checkout <分支> [--name N] [--root R] —— 缺少分支名');
  const { main, config } = await getBucket();
  if (!main.git) throw blocked('当前目录不是 git 仓库: ' + main.path);
  if (!branchExists(main.path, branch)) throw notFound(`分支不存在: ${branch}（先创建或 fetch）`);

  const occupied = parseWorktreePorcelain(worktreePorcelain(main.path)).find(
    (r) => r.branch === branch
  );
  if (occupied) throw conflict(`分支已被工作树占用: ${occupied.path}`);

  const session = slug(input.name || branch);
  const root = resolve(String(input.root || config.worktreeRoot));
  const target = join(root, session);
  if ((await statOrNull(target)) !== null) throw conflict('目标目录已存在: ' + target);

  await fsp.mkdir(root, { recursive: true });
  const args = ['worktree', 'add'];
  if (input.force) args.push('--force');
  args.push(target, branch);
  git(main.path, args);

  return { status: 'ok', name: session, branch, path: target, cd: target };
}

export async function removeWorktree(ref, { branch: delBranch = false, force = false } = {}) {
  const { main, worktrees } = await listWorktrees();
  if (!main.git) throw blocked('不是 git 仓库: ' + main.path);
  const wt = matchWorktree(worktrees, ref);
  if (!wt) throw notFound(`工作树不存在: ${ref}（用 nx-rh wt list 查看）`);
  if (wt.isMain) throw blocked('不能移除主工作树: ' + wt.path);

  if (wt.dirty && !force) {
    return {
      status: 'blocked',
      name: wt.name,
      path: wt.path,
      reason: '工作树有未提交改动；确认删除加 --force',
    };
  }

  const rm = git(
    main.path,
    ['worktree', 'remove', ...(force ? ['--force'] : []), wt.path],
    { allowFail: true }
  );
  if (rm.code !== 0) {
    if (!force) {
      return { status: 'blocked', name: wt.name, path: wt.path, reason: (rm.stderr || rm.stdout).trim() };
    }
    throw external(`移除工作树失败: ${(rm.stderr || rm.stdout).trim()}`);
  }

  let branchDeleted = false;
  if (delBranch && wt.branch) {
    const d = git(main.path, ['branch', '-d', wt.branch], { allowFail: true });
    if (d.code === 0) {
      branchDeleted = true;
    } else if (force) {
      git(main.path, ['branch', '-D', wt.branch]);
      branchDeleted = true;
    } else {
      return {
        status: 'ok',
        removed: wt.name,
        path: wt.path,
        branchDeleted: false,
        branchKept: wt.branch,
        note: '分支未完全合并，已保留；连同删除再加 --force',
      };
    }
  }
  return { status: 'ok', removed: wt.name, path: wt.path, branchDeleted };
}

export async function switchWorktree(ref) {
  const { worktrees } = await listWorktrees();
  const wt = matchWorktree(worktrees, ref);
  if (!wt) throw notFound(`工作树不存在: ${ref}（用 nx-rh wt list 查看）`);
  return { status: 'ok', name: wt.name, path: wt.path, cd: wt.path };
}

export async function openWorktree(ref) {
  const { worktrees } = await listWorktrees();
  const wt = matchWorktree(worktrees, ref);
  if (!wt) throw notFound(`工作树不存在: ${ref}`);
  openPath(wt.path);
  return { status: 'ok', opened: wt.path };
}

// ---- 初始化与配置 ----

const CONFIG_FIELDS = ['branchPrefix', 'baseBranch', 'worktreeRoot', 'syncMode'];

export async function getConfig() {
  const { main, config } = await getBucket();
  return {
    git: main.git,
    main: main.path,
    currentWorktree: main.linked ? main.top : null,
    ...config,
  };
}

export async function setConfig(patch) {
  const main = await resolveMainRepoInfo();
  if (!main.git) throw blocked('当前目录不是 git 仓库: ' + main.path);

  await patchBucket(main.path, (b) => {
    for (const f of CONFIG_FIELDS) {
      if (patch[f] !== undefined && patch[f] !== '') b.config[f] = String(patch[f]);
    }
    if (b.config.syncMode && !['copy', 'symlink'].includes(b.config.syncMode)) {
      throw badInput('syncMode 只能是 copy | symlink');
    }
    if (b.config.worktreeRoot && !isAbsolute(b.config.worktreeRoot)) {
      b.config.worktreeRoot = resolve(main.path, b.config.worktreeRoot);
    }
  });
  return getConfig();
}

export async function initWorktree(patch = {}) {
  const main = await resolveMainRepoInfo();
  if (!main.git) throw blocked(`当前目录不是 git 仓库，无法初始化: ${main.path}`);

  const provided = CONFIG_FIELDS.filter((f) => patch[f] !== undefined);
  if (provided.length) {
    await setConfig(Object.fromEntries(provided.map((f) => [f, patch[f]])));
  }
  const config = (await getBucket()).config;
  await fsp.mkdir(config.worktreeRoot, { recursive: true });

  // 工作树根若在主仓库内，登记进 .gitignore（git 才允许在其下挂工作树）
  let gitignoreAdded = null;
  const relRoot = relative(main.path, config.worktreeRoot);
  // 跨盘符时 relative 直接返回绝对路径；必须同时排除「绝对」与「..」才算在主仓库内
  const insideMain = !isAbsolute(relRoot) && !relRoot.startsWith('..');
  if (insideMain) {
    const giPath = join(main.path, '.gitignore');
    let text = '';
    try {
      text = await fsp.readFile(giPath, 'utf8');
    } catch {
      text = '';
    }
    const entry = relRoot.replace(/\\/g, '/').replace(/\/+$/, '') + '/';
    const have = parseGitignore(text).some(
      (e) => ignoreKey(e.path + (e.dirOnly ? '/' : '')) === ignoreKey(entry)
    );
    if (!have) {
      const sep = text && !text.endsWith('\n') ? '\n' : '';
      await fsp.writeFile(
        giPath,
        `${text}${sep}\n# 工作树根目录（nx-rh wt init）\n${entry}\n`,
        'utf8'
      );
      gitignoreAdded = entry;
    }
  }

  return { status: 'ok', main: main.path, config, gitignoreAdded };
}

// ---- 主项目上下文（一次性拿齐，解决「上下文不及时」） ----

export async function getContext(opts = {}) {
  const n = Number(opts.log) || 5;
  const bucket = await getBucket();
  if (!bucket.main.git) {
    return { git: false, project: bucket.main.path, message: '当前目录不是 git 仓库' };
  }
  const { main, config } = bucket;

  const mainBranch = currentBranch(main.path);
  const head = revParse(main.path, 'HEAD');
  const mainDirty = isDirty(main.path);
  const mainLog = git(main.path, ['log', '--oneline', '-n', String(n)], {
    allowFail: true,
  }).stdout.trimEnd();
  const mainStatus = git(main.path, ['status', '-sb'], { allowFail: true }).stdout.trimEnd();

  let currentWorktree = null;
  if (main.linked) {
    const curBranch = currentBranch(main.top);
    const ref = mainBranch || head;
    currentWorktree = {
      path: main.top,
      branch: curBranch,
      dirty: isDirty(main.top),
      divergence: { relativeTo: ref, ...aheadBehind(main.top, ref) },
    };
  }

  const mainExt = await inspectAt(main.path, bucket);
  const hereExt = main.linked ? await inspectAt(main.top, bucket) : null;

  const suggested = [];
  if (mainDirty) suggested.push(`主工作树有未提交改动：git -C "${main.path}" status -sb`);
  if (currentWorktree) {
    const { ahead, behind } = currentWorktree.divergence;
    if (behind) suggested.push(`当前工作树落后 ${behind} 个提交：nx-rh wt rebase`);
    if (ahead) suggested.push(`当前工作树领先 ${ahead} 个提交：nx-rh wt fanout 或提 PR`);
  }
  if (hereExt && hereExt.summary.missing) {
    suggested.push(`当前工作树缺 ${hereExt.summary.missing} 个扩展文件：nx-rh wt ext sync`);
  }
  if (mainExt.summary.changed) {
    suggested.push(`主项目有 ${mainExt.summary.changed} 个扩展文件已变更：nx-rh wt ext list`);
  }

  return {
    git: true,
    main: {
      path: main.path,
      branch: mainBranch,
      head,
      dirty: mainDirty,
      status: mainStatus,
      log: mainLog,
    },
    currentWorktree,
    baseBranch: config.baseBranch,
    extensions: { main: mainExt.summary, here: hereExt ? hereExt.summary : null },
    suggested,
  };
}

// ---- 扩展文件：盘点 / 登记 / 发现 / 改 / 删 ----

// 在某个目标根（主仓库或某工作树）上评估每个扩展文件的状态。
async function inspectAt(targetPath, bucket = null) {
  const b = bucket || (await getBucket());
  const isMain = resolve(targetPath).toLowerCase() === resolve(b.main.path).toLowerCase();
  const items = [];
  let present = 0;
  let changed = 0;
  let missing = 0;
  let upToDate = 0;
  let differs = 0;

  for (const rec of b.extensions) {
    const dest = isMain ? rec.absPath : join(targetPath, rec.relPath);
    const st = await statOrNull(dest);
    if (!st) {
      items.push({ id: rec.id, rel: rec.relPath, label: rec.label, present: false, outside: !!rec.outside });
      missing++;
      continue;
    }
    const fp = await fingerprint(dest, st);
    const item = {
      id: rec.id,
      rel: rec.relPath,
      label: rec.label,
      present: true,
      kind: st.isDirectory() ? 'dir' : 'file',
      fingerprint: fp,
      size: st.size,
      mtime: st.mtime.toISOString(),
    };
    if (isMain) {
      // 主仓库视角：与「登记时快照」比 → 登记后有没有变
      item.changed = fp !== rec.fingerprint;
      if (item.changed) changed++;
      else present++;
    } else {
      // 工作树视角：与「主项目当前内容」比 → 是不是最新
      const mainSt = await statOrNull(rec.absPath);
      const mainFp = mainSt ? await fingerprint(rec.absPath, mainSt) : null;
      item.upToDate = mainFp !== null && fp === mainFp;
      if (item.upToDate) upToDate++;
      else differs++;
    }
    items.push(item);
  }

  return {
    target: resolve(targetPath),
    isMain,
    items,
    summary: isMain
      ? { registered: b.extensions.length, present, changed, missing }
      : { registered: b.extensions.length, upToDate, differs, missing },
  };
}

// 默认评估目标：显式 --target > 当前所在工作树 > 主仓库
export async function listExtensions(opts = {}) {
  const bucket = await getBucket();
  if (!bucket.main.git) {
    return { target: bucket.main.path, isMain: true, items: [], summary: { registered: 0 } };
  }
  let target = bucket.main.path;
  if (opts.target) {
    const { worktrees } = await listWorktrees();
    const wt = matchWorktree(worktrees, opts.target);
    if (!wt) throw notFound('工作树不存在: ' + opts.target);
    target = wt.path;
  } else if (bucket.main.linked) {
    target = bucket.main.top;
  }
  return inspectAt(target, bucket);
}

export async function addExtension(input) {
  const abs0 = String(input.abspath ?? input.abs ?? input.path ?? '').trim();
  if (!abs0) throw badInput('用法: nx-rh wt ext add <绝对路径> [--label L] [--force] —— 缺少路径');
  const bucket = await getBucket();
  if (!bucket.main.git) throw blocked('当前目录不是 git 仓库: ' + bucket.main.path);

  const abs = resolve(abs0);
  const st = await statOrNull(abs);
  if (!st) throw notFound('文件不存在: ' + abs);

  const rel = relative(bucket.main.path, abs).replace(/\\/g, '/');
  const outside = rel.startsWith('..');

  if (!input.force) {
    const code = checkIgnore(bucket.main.path, abs);
    if (code === 1) {
      throw blocked(
        `文件未被 git 忽略（被跟踪或不在 .gitignore）: ${outside ? abs : rel}；扩展文件用于登记被忽略文件，确认登记加 --force`
      );
    }
  }

  const fp = await fingerprint(abs, st);
  const record = {
    id: newId('x'),
    absPath: abs,
    relPath: rel,
    outside,
    label: String(input.label || '').trim(),
    kind: st.isDirectory() ? 'dir' : 'file',
    fingerprint: fp,
    size: st.size,
    mtime: st.mtime.toISOString(),
    registeredAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await patchBucket(bucket.main.path, (b) => {
    if (b.extensions.some((e) => e.absPath.toLowerCase() === abs.toLowerCase())) {
      throw conflict('扩展文件已登记: ' + abs);
    }
    b.extensions.push(record);
  });
  return { status: 'ok', ...record };
}

// 发现被忽略文件：.gitignore 具体条目 + git ls-files（目录折叠，避免 node_modules 爆炸）。
// 默认只给建议（零副作用），--apply 才登记。
export async function discoverExtensions(input = {}) {
  const apply = input.apply === true;
  const bucket = await getBucket();
  if (!bucket.main.git) throw blocked('当前目录不是 git 仓库: ' + bucket.main.path);

  const proposals = new Map();
  // 工作树根（若在主仓库内）绝不能被当成扩展文件——否则同步会把根递归复制进工作树
  const rootRel0 = relative(bucket.main.path, bucket.config.worktreeRoot);
  const wtRootRel =
    !isAbsolute(rootRel0) && !rootRel0.startsWith('..')
      ? rootRel0.replace(/\\/g, '/').replace(/\/+$/, '')
      : null;

  const addP = (p0, source) => {
    const p = p0.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    if (!p || p === '.git') return;
    if (wtRootRel && (p === wtRootRel || p.startsWith(wtRootRel + '/'))) return;
    if (!proposals.has(p)) proposals.set(p, { rel: p, source });
  };

  let giText = '';
  try {
    giText = await fsp.readFile(join(bucket.main.path, '.gitignore'), 'utf8');
  } catch {
    giText = '';
  }
  for (const e of concreteEntries(parseGitignore(giText))) {
    // 防御：只收解析后仍落在主仓库内的条目（忽略跨盘符/含 .. 的异常规则）
    const rel = relative(bucket.main.path, join(bucket.main.path, e.path));
    if (!rel.startsWith('..') && !isAbsolute(rel)) addP(e.path, 'gitignore');
  }

  const ls = git(
    bucket.main.path,
    ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'],
    { allowFail: true }
  );
  if (ls.code === 0) {
    for (const line of ls.stdout.split(/\r?\n/)) {
      const p = line.trim();
      if (p) addP(p, 'git');
    }
  }

  const registered = new Set(bucket.extensions.map((e) => e.relPath));
  const items = [];
  for (const p of [...proposals.values()].slice(0, 1000)) {
    const abs = join(bucket.main.path, p.rel);
    const st = await statOrNull(abs);
    items.push({
      rel: p.rel,
      source: p.source,
      exists: !!st,
      kind: st ? (st.isDirectory() ? 'dir' : 'file') : null,
      alreadyRegistered: registered.has(p.rel),
    });
  }

  const registrable = items.filter((i) => i.exists && !i.alreadyRegistered);
  const added = [];
  if (apply) {
    for (const i of registrable) {
      try {
        added.push(await addExtension({ abspath: join(bucket.main.path, i.rel), force: true }));
      } catch {
        /* 重复等，跳过 */
      }
    }
  }

  return {
    apply,
    proposals: items,
    summary: {
      found: items.length,
      registrable: registrable.length,
      alreadyRegistered: items.filter((i) => i.alreadyRegistered).length,
      added: added.length,
    },
    added,
  };
}

function matchExtension(list, ref) {
  const r = String(ref || '').trim();
  let target;
  try {
    target = resolve(r);
  } catch {
    target = r;
  }
  return (
    list.find(
      (e) =>
        e.id === r ||
        e.relPath === r ||
        e.absPath.toLowerCase() === target.toLowerCase()
    ) || null
  );
}

export async function getExtension(ref) {
  const bucket = await getBucket();
  const rec = matchExtension(bucket.extensions, ref);
  if (!rec) throw notFound('扩展文件不存在: ' + ref);
  const inspected = await inspectAt(bucket.main.path, bucket);
  return { ...rec, state: inspected.items.find((i) => i.id === rec.id) };
}

export async function updateExtension(ref, patch) {
  const bucket = await getBucket();
  return patchBucket(bucket.main.path, (b) => {
    const rec = matchExtension(b.extensions, ref);
    if (!rec) throw notFound('扩展文件不存在: ' + ref);
    if (patch.label !== undefined) rec.label = String(patch.label).trim();
    rec.updatedAt = new Date().toISOString();
    return rec;
  });
}

export async function removeExtension(ref) {
  const bucket = await getBucket();
  return patchBucket(bucket.main.path, (b) => {
    const idx = b.extensions.findIndex((e) => matchExtension([e], ref));
    if (idx < 0) throw notFound('扩展文件不存在: ' + ref);
    const [removed] = b.extensions.splice(idx, 1);
    return { status: 'ok', removed: removed.relPath, diskUntouched: true };
  });
}

// ---- 扩展文件同步进工作树 ----

async function makeLink(src, dest, kind) {
  if (process.platform === 'win32' && kind === 'dir') {
    await fsp.symlink(src, dest, 'junction'); // 目录 junction 免管理员
  } else {
    await fsp.symlink(src, dest);
  }
}

export async function syncExtensions(input = {}) {
  const bucket = await getBucket();
  if (!bucket.main.git) throw blocked('当前目录不是 git 仓库: ' + bucket.main.path);

  let target;
  if (input.target) {
    const { worktrees } = await listWorktrees();
    const wt = matchWorktree(worktrees, input.target);
    if (!wt) throw notFound('工作树不存在: ' + input.target);
    target = wt.path;
  } else if (bucket.main.linked) {
    target = bucket.main.top;
  } else {
    throw blocked('当前不在工作树内；用 --target <工作树名|路径> 指定同步目标');
  }

  const mode = input.mode || bucket.config.syncMode;
  if (!['copy', 'symlink'].includes(mode)) throw badInput('mode 只能是 copy | symlink');

  const idSet = Array.isArray(input.ids) ? new Set(input.ids) : null;
  const selected = bucket.extensions.filter(
    (e) => !e.outside && (!idSet || idSet.has(e.id) || idSet.has(e.relPath))
  );

  const results = [];
  for (const rec of selected) {
    const dest = join(target, rec.relPath);
    const srcSt = await statOrNull(rec.absPath);
    if (!srcSt) {
      results.push({ rel: rec.relPath, action: 'missing' });
      continue;
    }
    // 以**主项目当前内容**为同步基准（不是登记时的快照）
    const srcFp = await fingerprint(rec.absPath, srcSt);
    const destSt = await statOrNull(dest);
    if (destSt) {
      const destFp = await fingerprint(dest, destSt);
      if (destFp === srcFp) {
        results.push({ rel: rec.relPath, action: 'skipped' });
        continue;
      }
      if (!input.force) {
        results.push({ rel: rec.relPath, action: 'conflict' });
        continue;
      }
    }
    if (input['dry-run']) {
      results.push({ rel: rec.relPath, action: destSt ? 'overwrite' : mode === 'copy' ? 'copy' : 'link' });
      continue;
    }

    await fsp.mkdir(dirname(dest), { recursive: true });
    try {
      if (mode === 'copy') {
        await fsp.cp(rec.absPath, dest, { recursive: true, force: input.force === true });
        results.push({ rel: rec.relPath, action: 'copied' });
      } else {
        await makeLink(rec.absPath, dest, rec.kind);
        results.push({ rel: rec.relPath, action: 'linked' });
      }
    } catch (e) {
      if (mode === 'symlink') {
        // 文件 symlink 在 Windows 常因权限失败：降级复制
        try {
          await fsp.cp(rec.absPath, dest, { recursive: true, force: true });
          results.push({ rel: rec.relPath, action: 'copied-fallback' });
        } catch (e2) {
          results.push({ rel: rec.relPath, action: 'error', detail: String(e2.message || e2) });
        }
      } else {
        results.push({ rel: rec.relPath, action: 'error', detail: String(e.message || e) });
      }
    }
  }

  const count = (a) => results.filter((r) => r.action === a).length;
  const summary = {
    target,
    mode,
    copied: count('copied') + count('copied-fallback'),
    linked: count('linked'),
    skipped: count('skipped'),
    conflict: count('conflict'),
    missing: count('missing'),
    error: count('error'),
  };
  return {
    status: summary.conflict || summary.error ? 'conflict' : 'ok',
    target,
    mode,
    results,
    summary,
  };
}

// ---- rebase / fanout ----

function performRebase(wtPath, baseRef) {
  const r = git(wtPath, ['rebase', baseRef], { allowFail: true });
  if (r.code === 0) return { status: 'ok', path: wtPath, base: baseRef };

  const statusTxt = git(wtPath, ['status', '--porcelain'], { allowFail: true }).stdout;
  const output = (r.stdout + r.stderr).trim();
  const isConflict =
    /CONFLICT|conflict|Failed to merge/i.test(output) || /^(?:.U|U.|AA|DD|AU|UA|DU|UD)/m.test(statusTxt);

  git(wtPath, ['rebase', '--abort'], { allowFail: true });
  if (isConflict) return { status: 'conflict', path: wtPath, base: baseRef, output: output.slice(-800) };
  return { status: 'blocked', path: wtPath, base: baseRef, reason: output.slice(-800) };
}

export async function rebaseWorktree(input = {}) {
  const bucket = await getBucket();
  if (!bucket.main.git) throw blocked('不是 git 仓库: ' + bucket.main.path);
  const { worktrees } = await listWorktrees();

  let wt;
  const ref = input.target || input.ref;
  if (ref) {
    wt = matchWorktree(worktrees, ref);
  } else if (bucket.main.linked) {
    wt = worktrees.find((w) => w.path === bucket.main.top);
  }
  if (!wt) throw notFound('未指定工作树，且当前不在工作树内（用 --target <工作树>）');

  const baseRef = String(
    input.base || currentBranch(bucket.main.path) || bucket.config.baseBranch
  ).trim();
  if (wt.isMain) return { status: 'blocked', reason: '主工作树不能作为 rebase 来源' };
  if (wt.branch === baseRef) return { status: 'blocked', reason: `不能把 ${baseRef} rebase 到自己` };

  if (wt.dirty) {
    const message = String(input.message || '').trim();
    if (!message) {
      return {
        status: 'blocked',
        path: wt.path,
        reason: '工作树有未提交改动；给 --message "..." 自动提交后再 rebase',
      };
    }
    git(wt.path, ['add', '-A']);
    git(wt.path, ['commit', '-m', message], { allowFail: true });
  }
  return performRebase(wt.path, baseRef);
}

export async function fanout(input = {}) {
  const bucket = await getBucket();
  if (!bucket.main.git) throw blocked('不是 git 仓库: ' + bucket.main.path);
  const { worktrees } = await listWorktrees();
  const baseRef = String(
    input.base || currentBranch(bucket.main.path) || bucket.config.baseBranch
  ).trim();

  const targets = worktrees.filter((w) => !w.isMain && w.branch && w.branch !== baseRef);
  const plan = targets.map((w) => {
    const blockers = [];
    if (w.dirty) blockers.push('有未提交改动');
    if (w.ahead !== null && w.ahead > 0) blockers.push(`领先 ${baseRef} ${w.ahead} 个提交`);
    return {
      name: w.name,
      path: w.path,
      branch: w.branch,
      ahead: w.ahead,
      behind: w.behind,
      safe: blockers.length === 0,
      blockers,
    };
  });

  const blockedCount = plan.filter((p) => !p.safe).length;
  if (!input.yes) return { status: 'planned', base: baseRef, plan, blockedCount };
  if (blockedCount) return { status: 'blocked', base: baseRef, plan, blockedCount };

  const completed = [];
  for (const p of plan) {
    const r = performRebase(p.path, baseRef);
    if (r.status !== 'ok') return { ...r, completed, failedAt: p.name };
    completed.push(p.name);
  }
  return { status: 'ok', base: baseRef, completed };
}

// ---- 聚合（bootstrap 用；非 git 目录安全降级，绝不抛） ----

export async function overview(startDir = projectRoot()) {
  try {
    const bucket = await getBucket(startDir);
    if (!bucket.main.git) return { git: false, project: bucket.main.path };

    const { worktrees } = await listWorktrees({ startDir });
    const evalTarget = bucket.main.linked ? bucket.main.top : bucket.main.path;
    const ext = await inspectAt(evalTarget, bucket);

    return {
      git: true,
      main: bucket.main.path,
      currentWorktree: bucket.main.linked ? bucket.main.top : null,
      config: bucket.config,
      worktrees,
      extTarget: ext.target,
      extSummary: ext.summary,
      extItems: ext.items,
    };
  } catch (e) {
    return { git: false, project: resolve(String(startDir)), error: String(e.message || e) };
  }
}
