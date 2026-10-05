// 迁移（source → target）与提交（target → source）：skill 在订阅源与平台目录之间的搬运。
// 目的仓库不参与冲突检测（直接被订阅源覆盖）；冲突检测只在订阅源之间（见 queries/sourceAudit）。
import { dirname, isAbsolute, join, resolve } from 'node:path';
import fsp from 'node:fs/promises';
import { exists, pathExists, diffTrees } from '../../../core/fstree.js';
import { detectLinkType, createSkillLink, sameRealPath, samePath } from '../../../core/link.js';
import { assertSafeName } from '../../../core/paths.js';
import { badInput, notFound } from '../../../core/errors.js';
import { getSettings, requireHubPath } from '../../settings/service.js';
import { resolveSkillsRoot } from './scan.js';
import { listSources, sourceEntriesFor } from './sources.js';
import { resolveTargets } from './targets.js';
import { selectSourceSkills, nameList, applyFilters, collectTargetSkills } from './select.js';
import { listAllSkills } from './queries.js';

// 把 srcDir 落到一个目标：已指向同一实体则跳过；**其余一律直接覆盖**。
// 目的仓库不参与冲突检测——它只是落地副本，订阅源里永远有一份，覆盖可恢复；
// 真正需要冲突检测的是**订阅源之间**（见 queries 的 sourceAudit）。
// dryRun=true 时只判定不落盘——批量操作前先预演是刚需。
async function placeAt(srcDir, name, target, mode, dryRun) {
  const dst = join(target.dir, name);
  const base = { ...target, path: dst };
  const lt = await detectLinkType(dst);
  if (lt) {
    const t = await fsp.readlink(dst).catch(() => null);
    if (t) {
      const absT = isAbsolute(t) ? t : resolve(dirname(dst), t);
      if (await sameRealPath(absT, srcDir)) {
        return { ...base, status: 'ok', skipped: true, linkType: lt };
      }
    }
  }
  const existed = await exists(dst);
  if (dryRun) {
    return existed
      ? { ...base, status: 'ok', mode, wouldReplace: true }
      : { ...base, status: 'ok', mode, wouldCreate: true };
  }

  if (mode === 'symlink') {
    const r = await createSkillLink(srcDir, dst);
    if (r.ok) {
      return { ...base, status: 'ok', mode: 'symlink', linkType: r.linkType, already: r.already };
    }
    // 链接失败 → 降级复制，迁移不因权限中断
    if (await exists(dst)) await fsp.rm(dst, { recursive: true, force: true });
    await fsp.cp(srcDir, dst, { recursive: true, dereference: true, force: true });
    return { ...base, status: 'ok', mode: 'copy', degraded: true, degradedReason: r.error };
  }
  if (await exists(dst)) await fsp.rm(dst, { recursive: true, force: true });
  await fsp.mkdir(dirname(dst), { recursive: true });
  await fsp.cp(srcDir, dst, { recursive: true, dereference: true, force: true });
  return { ...base, status: 'ok', mode: 'copy' };
}

// 迁移 skill 到目标集。选择方式：<name...> / --all / --include，再叠加 --exclude / --match。
// 目的仓库不做冲突检测（直接覆盖）；跨**订阅源**的冲突会 blocked，可用 --source 指定用哪一份。
export async function migrateSkill({
  name, names, all, include, exclude, match,
  to, platform, mode, project, source, dryRun,
} = {}) {
  const s = await getSettings();
  const m = mode === 'copy' || mode === 'symlink' ? mode : s.skillSyncMode;
  const targets = await resolveTargets({ to, platform, project });
  const list = await selectSourceSkills({ names: names ?? name, all, include, exclude, match });

  const results = [];
  const blocked = [];
  for (const sk of list) {
    // 跨源冲突：同名实文件出现在多个订阅源且内容不同。
    // 目的仓库可以直接覆盖，但**用哪份内容覆盖**必须先定——这是来源侧的冲突。
    const entries = await sourceEntriesFor(sk.name);
    let src = sk;
    if (entries.length > 1 && entries.some((e) => e.md5 !== entries[0].md5)) {
      const pick = source ? entries.find((e) => samePath(e.source, resolve(String(source)))) : null;
      if (source && !pick) {
        throw badInput(`--source 指定的订阅源里没有 ${sk.name}: ${source}`);
      }
      if (!pick) {
        for (const t of targets) {
          blocked.push({
            name: sk.name,
            platform: t.platform,
            platformName: t.platformName,
            scope: t.scope,
            dir: join(t.dir, sk.name),
            status: 'blocked',
            reason: '同名 skill 在多个订阅源且内容不同',
            sources: entries.map((e) => ({ source: e.source, md5: e.md5 })),
          });
        }
        continue;
      }
      src = pick;
    }
    for (const t of targets) {
      results.push({ name: sk.name, ...(await placeAt(src.dir, sk.name, t, m, dryRun)) });
    }
  }
  return {
    status: blocked.length ? 'blocked' : 'ok',
    dryRun: !!dryRun,
    mode: m,
    selected: list.map((x) => x.name),
    count: results.length,
    migrated: results.filter((r) => r.status === 'ok' && !r.skipped && !dryRun).length,
    wouldChange: results.filter((r) => r.status === 'ok' && !r.skipped).length,
    skipped: results.filter((r) => r.skipped).length,
    blocked,
    results,
  };
}

// 撤销迁移（target 侧移除）。候选来自目标扫描，因此**也能清掉不在订阅源的游离 skill**。
export async function unmigrateSkill({
  name, names, all, include, exclude, match,
  to, platform, project, force, dryRun,
} = {}) {
  const targets = await resolveTargets({ to, platform, project });
  const wanted = nameList(names ?? name);

  let base;
  if (wanted.length) {
    base = wanted.map((n) => ({ name: n, description: '' }));
  } else if (all || (include && include.length)) {
    base = await collectTargetSkills({ project });
  } else {
    throw badInput('需要 <name...>、--all 或 --include <模式> 之一');
  }
  const list = applyFilters(base, { include, exclude, match });
  if (!list.length) throw notFound('按当前筛选条件没有匹配的 skill');

  const removed = [];
  const needForce = [];
  const plan = [];
  for (const { name: n } of list) {
    for (const t of targets) {
      const dst = join(t.dir, n);
      if (!(await pathExists(dst))) continue;
      const lt = await detectLinkType(dst);
      const entry = { name: n, platform: t.platform, platformName: t.platformName, scope: t.scope, path: dst, linkType: lt };
      if (dryRun) {
        plan.push(entry);
        continue;
      }
      if (!lt && !force) {
        needForce.push(entry);
        continue;
      }
      await fsp.rm(dst, { recursive: true, force: true });
      removed.push(entry);
    }
  }
  if (dryRun) {
    return { status: 'ok', dryRun: true, selected: list.map((x) => x.name), removed: [], plan, needForce: [], missing: [] };
  }
  // 四个取值（A00 §八）：ok / skipped / conflict / blocked。
  // 「实体副本要 --force」属于 blocked——操作合法，但被规则挡住，先满足前置条件。
  if (needForce.length && !removed.length) {
    return {
      status: 'blocked',
      dryRun: false,
      selected: list.map((x) => x.name),
      removed,
      needForce,
      reason: `${needForce.length} 处是实体副本（可能含本地改动），删除不可逆，加 --force 确认`,
      missing: [],
    };
  }
  return { status: 'ok', dryRun: false, selected: list.map((x) => x.name), removed, needForce, missing: [] };
}

// 链接 → 实体（物化），使该目标不再随订阅源实时变化
export async function materializeSkill({ name, to, platform, project } = {}) {
  name = assertSafeName(name);
  const targets = await resolveTargets({ to, platform, project });
  const done = [];
  for (const t of targets) {
    const dst = join(t.dir, name);
    if (!(await pathExists(dst))) continue;
    const lt = await detectLinkType(dst);
    if (!lt) continue;
    const target = await fsp.readlink(dst);
    const absT = isAbsolute(target) ? target : resolve(dirname(dst), target);
    await fsp.rm(dst, { force: true });
    await fsp.cp(absT, dst, { recursive: true, dereference: true, force: true });
    done.push({ platform: t.platform, scope: t.scope, path: dst, source: absT });
  }
  return { converted: done.length > 0, results: done };
}

// ─── 提交（target → source） ────────────────────────────────────────
// 把平台目录里的实体 skill 收进订阅源，然后**删除目标的实文件**、
// 改回指向订阅源的链接 —— 收敛「唯一实文件 = 订阅源」这条规范。

async function submitOne(name, { targets, hubRoot, force, keepTarget, dryRun }) {
  name = assertSafeName(name);

  // 优先挑「实体」形态的来源（链接没什么可提交的）
  let picked = null;
  for (const t of targets) {
    const dst = join(t.dir, name);
    if (!(await pathExists(dst))) continue;
    const lt = await detectLinkType(dst);
    if (!picked || (!lt && picked.linkType)) picked = { ...t, path: dst, linkType: lt };
  }
  if (!picked) return { status: 'missing', name, reason: '目标目录里没有该 skill' };
  if (picked.linkType) {
    return { status: 'skipped', name, reason: '目标已是链接（本就指向某个源），无需提交', target: picked.path };
  }

  const dst = join(hubRoot, name);
  if (await exists(dst)) {
    const files = await diffTrees(picked.path, dst);
    if (files.length && !force) {
      return { status: 'conflict', name, files, path: dst, target: picked.path };
    }
  }
  if (dryRun) {
    return { status: 'ok', name, dryRun: true, sourceDir: dst, target: picked.path, wouldRelink: !keepTarget };
  }

  if (await exists(dst)) await fsp.rm(dst, { recursive: true, force: true });
  await fsp.mkdir(dirname(dst), { recursive: true });
  await fsp.cp(picked.path, dst, { recursive: true, dereference: true, force: true });

  // 删除目标实文件；默认改回软链接，保持项目可用（keepTarget=true 则只删不建链）
  let relinked = null;
  if (!keepTarget) {
    await fsp.rm(picked.path, { recursive: true, force: true });
    const r = await createSkillLink(dst, picked.path);
    relinked = r.ok ? r.linkType || 'symlink' : null;
    if (!r.ok) {
      // 建链失败时至少恢复一份副本，不能让项目凭空丢 skill
      await fsp.cp(dst, picked.path, { recursive: true, dereference: true, force: true });
    }
  }
  return { status: 'ok', name, sourceDir: dst, target: picked.path, relinked, keepTarget: !!keepTarget };
}

// 提交：<name...> 点名；或 --all / --include 取「不在订阅源」那一批（--exclude 排掉个别）。
// into：收进**哪个**订阅源（须已订阅；缺省当前主源）。与 migrate 的 --source 刻意区分——
// source = 用哪个源的内容（来源侧冲突），into = 落到哪个源（提交方向）。
export async function submitSkill({
  name, names, all, include, exclude, match,
  to, platform, project, force, keepTarget, dryRun, into,
} = {}) {
  const { sources } = await listSources();
  let hub;
  if (into) {
    const hit = sources.find((x) => samePath(x.path, resolve(String(into))));
    if (!hit) {
      throw badInput(`--into 不是已订阅的订阅源: ${into}（已订阅: ${sources.map((x) => x.path).join(' , ') || '无'}）`);
    }
    if (!hit.exists) throw notFound('--into 指定的订阅源目录不存在: ' + hit.path);
    hub = hit.path;
  } else {
    hub = await requireHubPath();
  }
  const targets = await resolveTargets({ to, platform, project });
  const hubRoot = await resolveSkillsRoot(hub);
  const wanted = nameList(names ?? name);

  let list;
  if (wanted.length) {
    list = wanted.map((n) => ({ name: n, description: '' }));
  } else if (all || (include && include.length)) {
    const scan = await listAllSkills({ project });
    list = scan.orphans.map((o) => ({ name: o.name, description: o.description || '' }));
  } else {
    throw badInput('需要 <name...>、--all 或 --include <模式> 之一');
  }
  const chosen = applyFilters(list, { include, exclude, match });
  if (!chosen.length) throw notFound('按当前筛选条件没有可提交的 skill（都已入 Hub？）');

  const results = [];
  for (const { name: n } of chosen) {
    results.push(await submitOne(n, { targets, hubRoot, force, keepTarget, dryRun }));
  }
  const conflicts = results.filter((r) => r.status === 'conflict');
  return {
    status: conflicts.length ? 'conflict' : 'ok',
    dryRun: !!dryRun,
    selected: chosen.map((x) => x.name),
    into: hub,
    count: results.length,
    submitted: results.filter((r) => r.status === 'ok' && !r.dryRun).length,
    wouldSubmit: results.filter((r) => r.status === 'ok').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    missing: results.filter((r) => r.status === 'missing').length,
    conflicts,
    results,
  };
}
