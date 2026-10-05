// git 原语：执行 git 子进程 + worktree porcelain 的纯解析。
// 零业务语义——「主仓库是谁、工作树放在哪、扩展文件怎么同步」这些策略
// 一律属于 modules/worktrees，本文件只提供机制。
import { spawnSync } from 'node:child_process';
import { external } from './errors.js';

const MAX_BUFFER = 128 * 1024 * 1024;

// 同步执行 git。
//   allowFail：非零退出不抛——rebase 冲突、分支未合并这类**业务分支**
//   调用方要读输出自己判定，不能被当成外部故障直接抛出。
export function git(cwd, args, { allowFail = false } = {}) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
  });
  if (r.error) throw external(`无法执行 git（${args.join(' ')}）: ${r.error.message}`);
  const code = r.status === null ? 0 : r.status;
  if (code !== 0 && !allowFail) {
    const detail = (r.stderr || r.stdout || '').trim();
    throw external(`git ${args.join(' ')} 失败: ${detail || '退出码 ' + code}`);
  }
  return { code, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// ---- 薄查询：只包一层，不做策略 ----

export function revParse(cwd, what) {
  return git(cwd, ['rev-parse', what]).stdout.trim();
}

// 是否在工作树内（不在仓库时返回 false，不抛）
export function isWorkTree(cwd) {
  const r = git(cwd, ['rev-parse', '--is-inside-work-tree'], { allowFail: true });
  return r.code === 0 && r.stdout.trim() === 'true';
}

// 仓库顶层（cwd 所在的**那个**工作树根；在链接工作树里返回工作树路径）
export function topLevel(cwd) {
  const r = git(cwd, ['rev-parse', '--show-toplevel'], { allowFail: true });
  return r.code === 0 ? r.stdout.trim() : null;
}

// 公共 git 目录（链接工作树指向主仓库的 .git）
export function gitCommonDir(cwd) {
  const r = git(cwd, ['rev-parse', '--git-common-dir'], { allowFail: true });
  return r.code === 0 ? r.stdout.trim() : null;
}

export function currentBranch(cwd) {
  const r = git(cwd, ['branch', '--show-current'], { allowFail: true });
  return r.code === 0 ? r.stdout.trim() : '';
}

// 工作树是否有未提交改动（含未跟踪文件）
export function isDirty(cwd) {
  const r = git(cwd, ['status', '--porcelain'], { allowFail: true });
  return r.code === 0 && r.stdout.trim() !== '';
}

// check-ignore：0=被忽略，1=未被忽略，128=出错
export function checkIgnore(cwd, absPath) {
  const r = git(cwd, ['check-ignore', absPath], { allowFail: true });
  return r.code;
}

// 分支引用是否存在
export function branchExists(cwd, branch) {
  const r = git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
    allowFail: true,
  });
  return r.code === 0;
}

// ahead / behind 计数；ref 无法解析时返回 null（基础分支可能本地不存在）
export function aheadBehind(cwd, ref) {
  const a = git(cwd, ['rev-list', '--count', `${ref}..HEAD`], { allowFail: true });
  if (a.code !== 0) return { ahead: null, behind: null };
  const b = git(cwd, ['rev-list', '--count', `HEAD..${ref}`], { allowFail: true });
  return {
    ahead: Number(a.stdout.trim()) || 0,
    behind: b.code === 0 ? Number(b.stdout.trim()) || 0 : null,
  };
}

// ---- worktree porcelain ----

export function worktreePorcelain(cwd) {
  return git(cwd, ['worktree', 'list', '--porcelain']).stdout;
}

// 纯函数：解析 `git worktree list --porcelain`。
// 记录以空行分隔，字段形如：
//   worktree <path>   HEAD <sha>   branch refs/heads/<b>
//   detached   bare   locked [reason]   prunable [reason]
export function parseWorktreePorcelain(text) {
  const out = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.path) out.push(cur);
    cur = null;
  };
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.trim() === '') {
      flush();
      continue;
    }
    if (!cur) cur = { path: '', head: '', branch: null, detached: false, bare: false, locked: false };

    if (line.startsWith('worktree ')) cur.path = line.slice('worktree '.length);
    else if (line.startsWith('HEAD ')) cur.head = line.slice('HEAD '.length);
    else if (line.startsWith('branch refs/heads/')) cur.branch = line.slice('branch refs/heads/'.length);
    else if (line === 'detached') cur.detached = true;
    else if (line === 'bare') cur.bare = true;
    else if (line === 'locked' || line.startsWith('locked ')) cur.locked = true;
  }
  flush();
  return out;
}
