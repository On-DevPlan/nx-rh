// 工作树生命周期：创建 / 挂载 / 移除 / 切换 / 打开。
import { join, resolve } from 'node:path';
import fsp from 'node:fs/promises';
import { badInput, blocked, conflict, external, notFound } from '../../../core/errors.js';
import { openPath } from '../../../core/open.js';
import { branchExists, git, parseWorktreePorcelain, worktreePorcelain } from '../../../core/git.js';
import { getBucket, slug, statOrNull } from './bucket.js';
import { listWorktrees, matchWorktree } from './list.js';

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
