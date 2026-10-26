// skill hub refresh：订阅源的更新检查——重新扫描并与上次快照对比。
//
// 分工边界（本工具「不管 git」）：上游有没有新提交由用户 git pull 决定；
// pull 之后跑这条，看「这次拉下来改了哪些 skill」——+新增 / -移除 / ~变更。
// 远程订阅仓库没有 pull 一说（它由本工具托管），refresh 顺带把台账指纹与
// 磁盘对齐（兜住手工改动，update 的基准不再漂）。
//
// 快照存 store.sourceSnapshots[sourcePath]；首次 refresh 没有基准，只建快照报「已记录」。
import { resolve } from 'node:path';
import { loadStore, mutateStore } from '../../../core/store.js';
import { badInput } from '../../../core/errors.js';
import { resolveSkillsRoot, scanSkillsRoot, skillDirHash } from './scan.js';
import { listSources } from './sources.js';
import { remoteRepoState } from './remote-repo.js';

function diff(before, after) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const [name, hash] of Object.entries(after)) {
    if (!(name in before)) added.push(name);
    else if (before[name] !== hash) changed.push(name);
  }
  for (const name of Object.keys(before)) {
    if (!(name in after)) removed.push(name);
  }
  return { added, removed, changed };
}

async function snapshotOf(sourcePath) {
  const root = await resolveSkillsRoot(sourcePath);
  const skills = await scanSkillsRoot(root, { realOnly: true });
  const out = {};
  for (const s of skills) out[s.name] = await skillDirHash(s.dir);
  return { root, skills: out };
}

// refresh [source]：source 是订阅源路径（子串匹配）；缺省 = 全部订阅源。
// 远程订阅仓库也在列表里（它就是一个源），其台账随后对齐。
export async function refreshSources(input, { dryRun } = {}) {
  const { sources } = await listSources();
  if (!sources.length) {
    return { status: 'ok', results: [], note: '没有订阅源（先 skill hub subscribe <路径>）' };
  }
  let targets = sources;
  if (input) {
    const low = String(input).toLowerCase();
    const abs = resolve(String(input)).toLowerCase();
    targets = sources.filter((s) => s.path.toLowerCase() === abs || s.path.toLowerCase().includes(low));
    if (!targets.length) throw badInput('找不到订阅源: ' + input);
  }

  const st = await loadStore();
  const snapshots = st.sourceSnapshots || {};
  const results = [];
  for (const s of targets) {
    if (!s.exists) {
      results.push({ source: s.path, error: '目录不存在' });
      continue;
    }
    const before = snapshots[s.path]?.skills || {};
    const snap = await snapshotOf(s.path);
    const isRemote = !!s.remote;
    // 首次没有基准：只建快照；远程订阅仓库另有台账（remoteRepo.skills）可当首次基准
    let base = before;
    if (!Object.keys(before).length && isRemote) {
      const repo = await remoteRepoState();
      const known = {};
      for (const [name, meta] of Object.entries(repo.skills || {})) {
        if (meta.hash) known[name] = meta.hash;
      }
      if (Object.keys(known).length) base = known;
    }
    const d = diff(base, snap.skills);
    const clean = !d.added.length && !d.removed.length && !d.changed.length;

    if (isRemote) {
      // 远程订阅仓库：refresh 顺带把台账指纹与磁盘对齐（手工改动后 update 基准不漂）
      await mutateStore((store) => {
        const repo = store.remoteRepo.skills || {};
        for (const name of d.changed) {
          if (repo[name]) store.remoteRepo.skills[name].hash = snap.skills[name];
        }
        for (const name of d.added) {
          if (!repo[name]) {
            store.remoteRepo.skills[name] = {
              name, description: '', hash: snap.skills[name],
              spec: '', url: '', ref: '', skillPath: name,
              importedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
            };
          }
        }
        for (const name of d.removed) delete store.remoteRepo.skills[name];
      });
    }

    if (!dryRun) {
      await mutateStore((store) => {
        store.sourceSnapshots[s.path] = { skills: snap.skills, scannedAt: new Date().toISOString() };
      });
    }
    results.push({
      source: s.path,
      remote: isRemote,
      clean,
      ...(isRemote ? {} : d),
      // 远程仓库的 added/removed 交给 remote update/refresh 语义，避免双重报告误导
      ...(isRemote ? { aligned: d.changed.length } : {}),
      firstTime: !Object.keys(before).length && !isRemote,
    });
  }
  return { status: 'ok', results, dryRun: !!dryRun };
}
