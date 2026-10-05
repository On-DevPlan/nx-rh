// 工作树模块的 CLI 人读渲染。只做「service 数据 → 终端文本」，不做任何 IO。
// 声明（index.js 的 actions）引用这里的函数；改文案只动本文件。
// ---- 人读渲染（Web 端拿 JSON，用不到这些） ----

export const shortHead = (h) => String(h || '').slice(0, 8);

export function wtBits(w) {
  const t = [];
  if (w.isMain) t.push('主');
  if (w.dirty) t.push('改动');
  if (w.detached) t.push('分离HEAD');
  if (w.ahead) t.push(`↑${w.ahead}`);
  if (w.behind) t.push(`↓${w.behind}`);
  if (w.extMissing) t.push(`缺扩展${w.extMissing}`);
  return t.length ? '  [' + t.join(' ') + ']' : '';
}

export function renderWtList(d) {
  if (!d.main.git) return `（${d.main.path} 不是 git 仓库）`;
  const lines = [
    `主仓库: ${d.main.path}`,
    `基础分支: ${d.config.baseBranch}    工作树根: ${d.config.worktreeRoot}`,
    `共 ${d.worktrees.length} 个工作树`,
  ];
  for (const w of d.worktrees) {
    lines.push(`  ${(w.branch || '(detached)').padEnd(34)}${shortHead(w.head)}${wtBits(w)}`);
    lines.push(`    ${w.path}`);
  }
  return lines.join('\n');
}

export function renderWt(w) {
  const lines = [
    `${w.name}${wtBits(w)}`,
    `  路径:   ${w.path}`,
    `  分支:   ${w.branch || '(detached)'}    HEAD: ${shortHead(w.head)}`,
  ];
  if (w.log) lines.push('', '  最近提交:', ...w.log.split('\n').map((l) => '    ' + l));
  if (w.extensions?.items?.length) {
    lines.push('', '  扩展文件:');
    for (const e of w.extensions.items) {
      lines.push(
        `    ${e.present ? (e.upToDate ? '  ' : '差异') : '缺失'}  ${e.rel}${e.label ? '  (' + e.label + ')' : ''}`
      );
    }
  }
  return lines.join('\n');
}

export const cdLine = (r) =>
  [`已${r.branch ? '创建' : '挂载'}: ${r.branch || r.name}`, `  路径: ${r.path}`, '', `cd "${r.path}"`].join('\n');

export function renderRemove(r) {
  if (r.status === 'blocked') return `未删除: ${r.name} —— ${r.reason}`;
  const lines = [`已移除工作树: ${r.removed}`];
  if (r.branchDeleted) lines.push('关联分支已删除');
  if (r.branchKept) lines.push(`分支保留: ${r.branchKept}（${r.note}）`);
  return lines.join('\n');
}

export function renderConfig(c) {
  const lines = [
    `主仓库: ${c.main}${c.git ? '' : '（非 git 仓库）'}`,
    c.currentWorktree ? `当前工作树: ${c.currentWorktree}` : '',
    `  分支前缀:   ${c.branchPrefix}`,
    `  基础分支:   ${c.baseBranch}`,
    `  工作树根:   ${c.worktreeRoot}`,
    `  扩展同步:   ${c.syncMode}`,
  ].filter(Boolean);
  return lines.join('\n');
}

export function renderInit(r) {
  const lines = ['工作树机制已就绪', `  主仓库: ${r.main}`];
  if (r.gitignoreAdded) lines.push(`  已登记 .gitignore: ${r.gitignoreAdded}`);
  lines.push(`  工作树根: ${r.config.worktreeRoot}`);
  lines.push('', '下一步: nx-rh wt add "<你要做的事>"');
  return lines.join('\n');
}

export function renderContext(c) {
  if (!c.git) return `（${c.project} 不是 git 仓库）`;
  const m = c.main;
  const lines = [
    `主项目: ${m.path}`,
    `  分支: ${m.branch || '(detached)'}   HEAD: ${shortHead(m.head)}   ${m.dirty ? '有未提交改动' : '干净'}`,
    '',
    '  ' + m.status.split('\n').join('\n  '),
    '',
    '  最近提交:',
    ...m.log.split('\n').map((l) => '    ' + l),
  ];
  if (c.currentWorktree) {
    const w = c.currentWorktree;
    const d = w.divergence;
    lines.push(
      '',
      `当前工作树: ${w.path}`,
      `  分支: ${w.branch || '(detached)'}   ${w.dirty ? '有未提交改动' : '干净'}   相对 ${d.relativeTo}: ↑${d.ahead ?? '?'} ↓${d.behind ?? '?'}`
    );
  }
  const em = c.extensions.main;
  lines.push('', `扩展文件（主项目）: 登记 ${em.registered}，在场 ${em.present}，变更 ${em.changed}，缺失 ${em.missing}`);
  if (c.extensions.here) {
    const eh = c.extensions.here;
    lines.push(`扩展文件（当前树）: 一致 ${eh.upToDate}，差异 ${eh.differs}，缺失 ${eh.missing}`);
  }
  if (c.suggested.length) {
    lines.push('', '建议指令:');
    for (const s of c.suggested) lines.push('  - ' + s);
  }
  return lines.join('\n');
}

// ---- 扩展文件渲染 ----

export function renderExtList(d) {
  const head = d.isMain ? `评估目标（主仓库）: ${d.target}` : `评估目标（工作树）: ${d.target}`;
  if (!d.items.length) return `${head}\n（暂无扩展文件，用 nx-rh wt ext add <绝对路径> 登记，或 wt ext discover 发现）`;
  const lines = [head];
  for (const e of d.items) {
    if (!e.present) {
      lines.push(`  缺失  ${e.rel}${e.label ? '  (' + e.label + ')' : ''}`);
    } else if (d.isMain) {
      lines.push(`  ${e.changed ? '变更' : '一致'}  ${e.rel}${e.label ? '  (' + e.label + ')' : ''}`);
    } else {
      lines.push(`  ${e.upToDate ? '一致' : '差异'}  ${e.rel}${e.label ? '  (' + e.label + ')' : ''}`);
    }
  }
  const s = d.summary;
  lines.push('', d.isMain
    ? `登记 ${s.registered}，在场 ${s.present}，变更 ${s.changed}，缺失 ${s.missing}`
    : `登记 ${s.registered}，一致 ${s.upToDate}，差异 ${s.differs}，缺失 ${s.missing}`);
  return lines.join('\n');
}

export function renderDiscover(d) {
  const s = d.summary;
  const lines = [
    d.apply ? `已登记 ${s.added} 个扩展文件` : `发现 ${s.found} 个候选，可登记 ${s.registrable} 个，已登记 ${s.alreadyRegistered} 个`,
  ];
  for (const p of d.proposals) {
    const mark = p.alreadyRegistered ? '已登记' : p.exists ? '可登记' : '不存在';
    lines.push(`  ${mark.padEnd(4)} [${p.source}] ${p.rel} (${p.kind || '-'})`);
  }
  if (!d.apply) lines.push('', `确认登记全部候选：nx-rh wt ext discover --apply`);
  return lines.join('\n');
}

export function renderExtAdded(r) {
  return `已登记扩展文件: ${r.relPath}  [${r.kind}]${r.label ? '  (' + r.label + ')' : ''}`;
}

export function renderExtUpdated(r) {
  return `已更新: ${r.relPath}${r.label ? '  (' + r.label + ')' : ''}`;
}

export function renderExtRemoved(r) {
  return `已移除扩展文件登记: ${r.removed}（磁盘文件未动）`;
}

export function renderSync(d) {
  const lines = [`同步到工作树: ${d.target}（方式: ${d.mode}）`];
  for (const r of d.results) {
    lines.push(`  ${r.action.padEnd(9)} ${r.rel}${r.detail ? '  ' + r.detail : ''}`);
  }
  const s = d.summary;
  lines.push('', `复制 ${s.copied}，链接 ${s.linked}，跳过 ${s.skipped}，冲突 ${s.conflict}，缺失 ${s.missing}，错误 ${s.error}`);
  if (s.conflict) lines.push('有冲突：确认覆盖加 --force 后重跑');
  return lines.join('\n');
}

// ---- rebase / fanout 渲染 ----

export function renderRebase(r) {
  if (r.status === 'ok') return `已 rebase 到 ${r.base}: ${r.path}`;
  if (r.status === 'conflict') {
    return [`冲突，已自动 abort: ${r.path} -> ${r.base}`, r.output].join('\n');
  }
  return `未执行: ${r.path} —— ${r.reason}`;
}

export function renderFanout(r) {
  if (r.status === 'ok') return `Fanout 完成: ${r.completed.length} 个 -> ${r.base}\n  ${r.completed.join('\n  ')}`;
  if (r.status === 'conflict') {
    return [
      `Fanout 在「${r.failedAt}」遇到冲突，已 abort；已完成: ${r.completed.join(', ') || '无'}`,
      r.output || '',
    ].join('\n');
  }
  if (r.status === 'blocked') {
    return [`Fanout 被阻止（基础 ${r.base}）:`, ...r.plan.map((p) => `  ${p.name}: ${p.blockers.join('; ')}`)].join('\n');
  }
  // planned
  const lines = [`Fanout 计划（基础 ${r.base}）：${r.plan.length} 个目标，${r.blockedCount} 个不可执行`];
  for (const p of r.plan) {
    lines.push(p.safe ? `  可执行  ${p.branch} (${p.name})` : `  阻止    ${p.branch} (${p.name}) — ${p.blockers.join('; ')}`);
  }
  lines.push('', '确认执行: nx-rh wt fanout --yes');
  return lines.join('\n');
}
