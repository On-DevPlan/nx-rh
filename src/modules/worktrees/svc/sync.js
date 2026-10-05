// 扩展文件同步进工作树：以**主项目当前内容**为基准（不是登记时的快照）。
import { dirname, join } from 'node:path';
import fsp from 'node:fs/promises';
import { badInput, blocked, notFound } from '../../../core/errors.js';
import { getBucket, statOrNull, fingerprint } from './bucket.js';
import { listWorktrees, matchWorktree } from './list.js';

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
