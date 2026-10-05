// 主项目上下文（一次性拿齐，解决「上下文不及时」）与 bootstrap 聚合。
import { resolve } from 'node:path';
import { projectRoot } from '../../../core/paths.js';
import { aheadBehind, currentBranch, git, isDirty, revParse } from '../../../core/git.js';
import { getBucket } from './bucket.js';
import { inspectAt } from './inspect.js';
import { listWorktrees } from './list.js';

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

// 聚合（bootstrap 用；非 git 目录安全降级，绝不抛）
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
