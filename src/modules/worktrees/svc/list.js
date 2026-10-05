// 工作树清单（git 真相 + 富状态）与按名/路径/分支的匹配。
import { basename, join, resolve } from 'node:path';
import { notFound } from '../../../core/errors.js';
import { aheadBehind, git, isDirty, parseWorktreePorcelain, worktreePorcelain } from '../../../core/git.js';
import { getBucket, statOrNull } from './bucket.js';
import { inspectAt } from './inspect.js';

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

export function matchWorktree(worktrees, ref) {
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
