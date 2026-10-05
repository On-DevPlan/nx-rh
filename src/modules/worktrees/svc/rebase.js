// rebase / fanout：把工作树 rebase 到主项目分支；fanout 先出安全计划再顺序执行。
import { currentBranch, git } from '../../../core/git.js';
import { blocked, notFound } from '../../../core/errors.js';
import { getBucket } from './bucket.js';
import { listWorktrees, matchWorktree } from './list.js';

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
