// 扩展文件在某个目标根上的状态评估。独立成文件是拆分的破环点：
// getWorktree（list 域）与 listExtensions（ext 域）都要用它，而它只依赖 bucket。
import { join, resolve } from 'node:path';
import { getBucket, statOrNull, fingerprint } from './bucket.js';

// 在某个目标根（主仓库或某工作树）上评估每个扩展文件的状态。
export async function inspectAt(targetPath, bucket = null) {
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
