// skill hub sync：远程订阅源的版本追踪与更新。
//
// 语义：重新拉取 → 按目录指纹对比（新增 / 移除 / 变更）→ 换入新内容并刷新
// 元数据里的 skills 快照；--dry-run 只拉到 staging 对比后弃置，磁盘不动。
// 指纹与快照在 scan.js（skillDirHash / snapshotSkills）；拉取与换入复用
// remote.js 的 materializeRemote / commitRemote——sync 与 subscribe 走同一条
// 落地路径，行为不可能分叉。
//
// 变更判定对齐 vercel-labs/skills 的 update 思路（skill-lock.ts 的 tree SHA
// 对比：哈希不变不折腾）；「只更新有变化的」在 nx-rh 的模型里天然成立——
// 平台侧迁移默认是软链，hub 内容换新后链接自动指向新内容，无需逐 skill 动作。
import fsp from 'node:fs/promises';
import { resolve } from 'node:path';
import { badInput } from '../../../core/errors.js';
import { parseSource } from './remote-parse.js';
import { materializeRemote, commitRemote, remoteMetaMap } from './remote.js';
import { snapshotSkills } from './scan.js';

// 对比两份快照：以 after 视角报告 added / removed / changed
function diffSnapshots(before, after) {
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

async function syncOne(registered, meta, dryRun) {
  const parsed = parseSource(meta.spec);
  parsed.spec = meta.spec; // 元数据里的原规格原样保留（哈希过 ref 的形态别漂移）
  const before = meta.skills || {};
  const { staging, sourceDir } = await materializeRemote(parsed);
  try {
    const after = await snapshotSkills(sourceDir);
    const diff = diffSnapshots(before, after);
    const clean = !diff.added.length && !diff.removed.length && !diff.changed.length;
    if (dryRun) {
      await fsp.rm(staging, { recursive: true, force: true });
      return { source: registered, spec: meta.spec, dryRun: true, clean, ...diff };
    }
    // 无变化也照常换入：内容一致，换入只刷新 fetchedAt（幂等、无副作用）
    await commitRemote(parsed, staging, sourceDir, after);
    return { source: registered, spec: meta.spec, clean, ...diff, fetchedAt: new Date().toISOString() };
  } catch (err) {
    await fsp.rm(staging, { recursive: true, force: true });
    throw err;
  }
}

// sync [source]：source 是注册路径 / 原规格 / id 的任一匹配（子串即可）；
// 缺省 = 全部远程源。本地源不适用（它没有「上游」）。
// 批量语义与 purge 一致：单条失败不挡其余，逐条上报。
export async function syncSource(input, { dryRun = false } = {}) {
  const metas = await remoteMetaMap();
  const entries = Object.entries(metas);
  if (!entries.length) {
    return { status: 'ok', results: [], note: '没有远程订阅源（先 skill hub subscribe <owner/repo|git URL>）' };
  }

  let targets = entries;
  if (input) {
    const low = String(input).toLowerCase();
    const abs = resolve(String(input)).toLowerCase();
    targets = entries.filter(
      ([p, m]) =>
        p.toLowerCase() === abs ||
        p.toLowerCase().includes(low) ||
        (m.spec || '').toLowerCase().includes(low) ||
        (m.id || '').toLowerCase().includes(low)
    );
    if (!targets.length) {
      throw badInput('找不到远程订阅源: ' + input + '（sync 只作用于远程源；本地源没有上游可拉）');
    }
  }

  const results = [];
  for (const [registered, meta] of targets) {
    try {
      results.push(await syncOne(registered, meta, dryRun));
    } catch (err) {
      results.push({ source: registered, spec: meta.spec, error: String(err.message || err) });
    }
  }
  return { status: 'ok', results, dryRun };
}
