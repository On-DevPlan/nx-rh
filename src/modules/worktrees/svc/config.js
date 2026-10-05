// 初始化与模块配置：分支前缀 / 工作树根 / 基础分支 / 同步方式。
import { isAbsolute, join, relative, resolve } from 'node:path';
import fsp from 'node:fs/promises';
import { badInput, blocked } from '../../../core/errors.js';
import { ignoreKey, parseGitignore } from '../../../core/gitignore.js';
import { getBucket, patchBucket, resolveMainRepoInfo } from './bucket.js';

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
