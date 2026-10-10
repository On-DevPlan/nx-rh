// Skill 模块的 CLI 人读渲染。只做「service 数据 → 终端文本」，不做任何 IO。
// 声明（index.js 的 actions）引用这里的函数；改文案只动本文件。
import { SCOPE_MARK, sourceLabel, sourceLabels } from './shared.js';

// index.js 内联 render 也会用到；从这里 re-export 保持单一 import 面。
export { SCOPE_MARK, sourceLabel, sourceLabels };

function cellText(cells) {
  if (!cells?.length) return '';
  const on = cells.filter((c) => c.on);
  if (!on.length) return '未安装';
  return on
    .map((c) => `${SCOPE_MARK[c.scope] || c.scope}·${c.platform}${c.linkType ? '(链接)' : '(副本)'}`)
    .join(' ');
}

export function renderSkillList(d, ctx) {
  const lines = [`订阅源: ${d.hub.path || '（未订阅）'}`];
  for (const s of d.sources || []) {
    lines.push(`  ${s.current ? '*' : ' '} ${s.path}  (${s.count} 个)`);
  }
  lines.push('');
  // 来源侧只认实文件；这里列出**订阅配置**的问题与跨源冲突（与目的仓库无关）
  for (const p of d.hubProblems || []) {
    lines.push(`! ${p.reason}  —— ${p.path}`);
  }
  for (const c of (d.conflicts || []).filter((x) => !x.same)) {
    lines.push(`! 同名 skill 在多个订阅源且内容不同: ${c.name}  —— ${sourceLabels(c.sources)}`);
  }
  for (const c of (d.conflicts || []).filter((x) => x.same)) {
    lines.push(`· 重复订阅（内容一致）: ${c.name}  —— ${sourceLabels(c.sources)}`);
  }
  if ((d.hubProblems || []).length || (d.conflicts || []).length) lines.push('');
  const srcAll = [...new Set(d.skills.map((s) => s.source))];
  const multi = srcAll.length > 1;
  if (!d.skills.length) lines.push('（订阅源里暂无 skill）');
  for (const s of d.skills) {
    if (ctx && ctx.long) {
      // 详细态：完整描述 + 目录 + 迁移现状，一个 skill 一块
      lines.push(s.name);
      lines.push(`  目录: ${s.dir}`);
      lines.push(`  来源: ${s.source}`);
      if (s.alsoIn?.length) lines.push(`  同时存在于: ${s.alsoIn.join(', ')}`);
      lines.push(`  描述: ${s.description}`);
      lines.push(`  安装: ${cellText(s.cells) || '未安装'}`);
      lines.push('');
      continue;
    }
    const tag = multi ? `  [${sourceLabel(s.source, srcAll)}]` : '';
    lines.push(`${s.name.padEnd(28)} ${(s.description || '').slice(0, 48)}${tag}`.trimEnd());
  }
  if (d.orphans?.length) {
    lines.push('');
    lines.push(`不在订阅源（${d.orphans.length} 个，可 skill submit 收进）:`);
    for (const o of d.orphans) lines.push(`  ${o.name.padEnd(26)} ${cellText(o.cells)}`);
  }
  if (!ctx || !ctx.long) {
    lines.push('');
    lines.push('（--long 看完整描述与目录；skill hub show <name> 看各平台安装状态）');
  }
  return lines.join('\n');
}

export function renderSources(d) {
  if (!d.sources.length) return '（暂无订阅源，用 nx-rh skill hub subscribe <path> 添加）';
  return d.sources.map((s) => `${s.current ? '*' : ' '} ${s.path}  (${s.count} 个)${s.exists ? '' : '  [目录不存在]'}`).join('\n');
}

// 当前项目目录里的 skill：目录清单 + 每 skill 一行（· 前缀 = 不在订阅源）
export function renderProjectList(d) {
  const lines = [`项目目录: ${d.projectRoot}`];
  for (const dir of d.dirs) {
    lines.push(`  ${dir.enabled ? '*' : ' '} ${dir.dir}  (${dir.skills.length} 个${dir.enabled ? '' : '，平台未启用'})`);
  }
  if (!d.skills.length) lines.push('', '（项目目录里没有 skill）');
  for (const s of d.skills) {
    lines.push(`${s.inHub ? '  ' : '· '}${s.name.padEnd(28)} ${(s.description || '').slice(0, 48)}`.trimEnd());
    lines.push(`    安装于: ${s.cells.map((c) => c.platformName || c.platform).join(' / ')}`);
  }
  if (d.skills.some((s) => !s.inHub)) {
    lines.push('', '（· 开头 = 不在订阅源，可用 nx-rh skill submit <name> 收进）');
  }
  return lines.join('\n');
}

export function renderMigrate(d) {
  if (!d.dryRun && d.status === 'blocked') {
    const lines = [`已阻止: ${d.blocked.length} 处无法迁移 —— 同名 skill 在多个订阅源且内容不同（来源冲突）`];
    const seen = new Set();
    for (const b of d.blocked) {
      if (seen.has(b.name)) continue;
      seen.add(b.name);
      const all = b.sources.map((s) => s.source);
      lines.push(`  ${b.name.padEnd(28)} ${b.sources.map((s) => `${sourceLabel(s.source, all)}(${s.md5.slice(0, 6)})`).join('  ')}`);
    }
    lines.push('先解决订阅（删掉多余来源），或用 --source <路径> 指定用哪一份。');
    return lines.join('\n');
  }
  const mark = (r) => {
    const where = `${SCOPE_MARK[r.scope] || r.scope}·${r.platform}`;
    if (r.skipped) return `${where} 已是最新`;
    if (d.dryRun) return `${where} ${r.wouldCreate ? '将创建' : '将覆盖'}`;
    const how = r.mode === 'symlink' ? `软链接 ${r.linkType || ''}`.trim() : '复制';
    return `${where} ${how}${r.degraded ? '（链接失败已降级复制）' : ''}`;
  };
  const multi = (d.selected || []).length > 1;
  const head = d.dryRun
    ? `预演（--dry-run，未改动磁盘）: 选中 ${d.selected.length} 个 · 将变更 ${d.wouldChange} 处 · 已是最新 ${d.skipped} 处`
    : `已迁移 ${d.migrated} 处（跳过 ${d.skipped}）· 选中 ${d.selected.length} 个`;
  const lines = [head];
  for (const r of d.results) lines.push(multi ? `  ${String(r.name || '').padEnd(28)} ${mark(r)}` : `  ${mark(r)}`);
  return lines.join('\n');
}

export function renderUnmigrate(d) {
  if (d.dryRun) {
    const lines = [`预演（--dry-run，未改动磁盘）: 选中 ${d.selected.length} 个 · 将移除 ${d.plan.length} 处`];
    for (const x of d.plan) lines.push(`  ${String(x.name).padEnd(28)} ${SCOPE_MARK[x.scope]}·${x.platform} ${x.linkType ? '链接' : '实体副本'}`);
    if (!d.plan.length) lines.push('  （这些目标本就没有该 skill）');
    return lines.join('\n');
  }
  if (d.status === 'blocked') {
    const list = d.needForce.map((x) => `  ${SCOPE_MARK[x.scope]}·${x.platform} ${x.path}`).join('\n');
    return `已阻止: ${d.reason}\n${list}`;
  }
  if (!d.removed.length) return '（这些目标本就没有该 skill）';
  const multi = (d.selected || []).length > 1;
  return `已撤销 ${d.removed.length} 处（选中 ${d.selected.length} 个）:\n${d.removed
    .map((x) => (multi
      ? `  ${String(x.name).padEnd(28)} ${SCOPE_MARK[x.scope]}·${x.platform} ${x.linkType ? '链接' : '副本'}`
      : `  ${SCOPE_MARK[x.scope]}·${x.platform} ${x.linkType ? '链接' : '副本'}`))
    .join('\n')}`;
}

export function renderSubmit(d) {
  if (!d.dryRun && d.status === 'conflict') {
    const c = d.conflicts[0];
    return `订阅源里已存在同名 skill 且内容不同（${c.files.length} 个文件）: ${c.path}\n用 --force 覆盖`;
  }
  // 批量形状（count 字段是新增的；单个提交走旧形状）
  if (d.count !== undefined) {
    if (d.dryRun) {
      const lines = [`预演（--dry-run，未改动磁盘）: 选中 ${d.selected.length} 个 · 将提交 ${d.wouldSubmit} 个`];
      for (const r of d.results) {
        lines.push(`  ${String(r.name).padEnd(28)} ${r.status === 'ok' ? '将收进订阅源并改回链接' : r.reason || r.status}`);
      }
      return lines.join('\n');
    }
    const lines = [`已提交 ${d.submitted} 个到订阅源（跳过 ${d.skipped} · 目标缺失 ${d.missing}）`];
    for (const r of d.results) {
      lines.push(`  ${String(r.name).padEnd(28)} ${r.status === 'ok' ? `→ ${r.sourceDir}` : r.reason || r.status}`);
    }
    return lines.join('\n');
  }
  if (d.skipped) return d.reason;
  return `已提交到订阅源: ${d.sourceDir}\n目标实文件已删除${d.relinked ? `，改回链接（${d.relinked}）` : '（未重建链接）'}`;
}

export function renderShow(d) {
  const lines = [d.name];
  lines.push(`  来源: ${d.source || '（不在订阅源，可 skill submit）'}`);
  if (d.dir) lines.push(`  目录: ${d.dir}`);
  if (d.alsoIn?.length) lines.push(`  同时存在于: ${d.alsoIn.join(', ')}`);
  lines.push(`  描述: ${d.description}`);
  if (d.outline?.length) {
    lines.push(`  结构（${d.stats?.sections ?? d.outline.length} 节 · ${d.stats?.lines ?? '?'} 行）:`);
    for (const h of d.outline) lines.push(`    ${'  '.repeat(h.level - 1)}${'#'.repeat(h.level)} ${h.text}`);
  }
  if (d.conflict && !d.conflict.same) {
    lines.push(`  ! 跨源冲突: 同名 skill 在多个订阅源且内容不同（${sourceLabels(d.conflict.sources)}）`);
    lines.push('    迁移会 blocked，先解决订阅或用 --source <路径> 指定用哪一份。');
  } else if (d.conflict) {
    lines.push(`  · 重复订阅（内容一致）: ${sourceLabels(d.conflict.sources)}`);
  }
  lines.push('  平台安装状态（skill hub migrate <name> --platform <id> --to user|global|project）：');
  for (const c of d.cells) {
    const head = `${SCOPE_MARK[c.scope] || c.scope}·${c.platformName || c.platform}`;
    lines.push(`    ${head.padEnd(22)} ${c.on ? c.linkType || '实体副本' : '未安装'}  ${c.dir}`);
  }
  if (d.alsoIn?.length) {
    lines.push('');
    lines.push('  提示：同名 skill 出现在多个订阅源里，迁移以「当前主源」为准。');
  }
  return lines.join('\n');
}

export function renderPurge(d) {
  const lines = [];
  if (d.status === 'blocked') lines.push(`已阻止: ${d.reason}`);
  else if (d.dryRun) lines.push(`预演（--dry-run，未改动磁盘）: 将彻底删除 ${d.plan.name}`);
  else lines.push(`已彻底删除 ${d.name}（${d.removed.length} 处）`);
  lines.push(d.dryRun || d.status === 'blocked' ? '  将删除:' : '  已删除:');
  for (const s of d.plan.sources) lines.push(`    订阅源  ${s.source}  →  ${s.dir}`);
  for (const c of d.plan.targets) {
    lines.push(`    安装位置  ${SCOPE_MARK[c.scope] || c.scope}·${c.platform}  ${c.path}${c.linkType ? '（链接）' : '（实体副本）'}`);
  }
  if (!d.plan.sources.length && !d.plan.targets.length) lines.push('    （无）');
  if (d.status === 'blocked') lines.push('', '确认无误后加 --force 执行。');
  return lines.join('\n');
}

// 唯一化（dedupe）：跨源重复/冲突收敛为「一份实文件（准份）+ 其余删除或转链接」
export function renderDedupe(d) {
  const lines = [];
  if (d.status === 'blocked') lines.push(`已阻止: ${d.reason}`);
  else if (d.dryRun) lines.push(`预演（--dry-run，未改动磁盘）: 唯一化 ${d.plan.name}`);
  else if (d.note) lines.push(`${d.note}: ${d.name}`);
  else lines.push(`已唯一化 ${d.name}（--as ${d.as}）`);
  lines.push(`  准份  ${d.plan.winner.md5.slice(0, 8)}  ${d.plan.winner.dir}`);
  const pending = d.dryRun || d.status === 'blocked';
  lines.push(pending ? `  其余将 --as ${d.plan.as}:` : `  其余已处理:`);
  for (const o of d.plan.others) {
    const hit = !pending && (d.linked.find((x) => x.dir === o.dir) || d.removed.find((x) => x.dir === o.dir));
    const mark = hit?.linkType ? `（${hit.linkType}）`
      : hit?.degraded ? `（建链失败，已回填副本: ${hit.reason}）`
        : hit ? '' : '';
    lines.push(`    ${o.md5.slice(0, 8)}  ${o.dir}${mark}`);
  }
  if (!d.plan.others.length) lines.push('    （无）');
  if (d.status === 'blocked') lines.push('', '确认无误后加 --force 执行。');
  return lines.join('\n');
}

// 批量唯一化（dedupe-all）：全部重复/冲突组一次收敛，主源实文件为准
export function renderDedupeAll(d) {
  if (d.note) return d.note;
  const lines = [];
  if (d.status === 'blocked') lines.push(`已阻止: ${d.reason}`);
  else if (d.dryRun) lines.push('预演（--dry-run，未改动磁盘）: 批量唯一化计划');
  else lines.push(`已批量唯一化 ${d.totals.groups} 组（--as ${d.as}）`);

  const pending = d.status === 'blocked' || d.dryRun;
  for (const g of d.groups) {
    lines.push(`  ${g.name}${g.noPrimary ? '（无主源实文件，取第一份为准）' : ''}`);
    lines.push(`    准份  ${g.winner.md5.slice(0, 8)}  ${g.winner.dir}`);
    if (pending) {
      for (const o of g.others) lines.push(`    其余将 --as ${d.as}  ${o.md5.slice(0, 8)}  ${o.dir}`);
      continue;
    }
    for (const l of g.linked) lines.push(`    → 链接（${l.linkType}）  ${l.dir}`);
    for (const r of g.removed) lines.push(`    → 删除${r.degraded ? `（建链失败，已回填副本: ${r.reason}）` : ''}  ${r.dir}`);
    for (const s of g.skipped) lines.push(`    → 跳过（${s.reason}）  ${s.dir}`);
  }
  if (!d.groups.length) lines.push('    （无）');
  if (!pending && d.totals) {
    lines.push(`  合计：${d.totals.groups} 组，转链接 ${d.totals.linked}，删除 ${d.totals.removed}，跳过 ${d.totals.skipped}`);
  }
  if (d.status === 'blocked') lines.push('', '确认无误后加 --force 执行。');
  return lines.join('\n');
}

// 适配器总表：每个平台的两个安装位置都打绝对路径——「把 skill 变成 .claude / .workbuddy / .cursor」
// 在终端里直接可抄，不需要先起面板。
export function renderAdapters(list) {
  const w = Math.max(...list.map((a) => a.id.length));
  return list
    .map((a) => {
      const tag = (a.enabled ? '[启用]' : '[   ]') + (a.isDefault ? ' [默认]' : '');
      return [
        `${a.id.padEnd(w)}  ${tag}  ${a.name}`,
        `  ${' '.repeat(w)}  项目  ${a.projectDir}`,
        `  ${' '.repeat(w)}  用户  ${a.userDir}`,
      ].join('\n');
    })
    .join('\n');
}
