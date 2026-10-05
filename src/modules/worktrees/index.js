// 工作树模块：action 声明是 CLI 命令、HTTP 路由、help 文案的唯一来源。
// 加一条操作 = 在 actions 里加一项，三端同时获得它。
//
// 本模块管理的工作树**真相在 git**（worktree list），不是本工具持有的集合，
// 因此不声明 resource、不硬套 CRUD——写操作是 rebase/fanout/remove 这些动词，
// 没有语义上的「update 一个工作树」。扩展文件（wt ext）则是完整的登记型集合。
import * as service from './service.js';

// ---- 人读渲染（Web 端拿 JSON，用不到这些） ----

const shortHead = (h) => String(h || '').slice(0, 8);

function wtBits(w) {
  const t = [];
  if (w.isMain) t.push('主');
  if (w.dirty) t.push('改动');
  if (w.detached) t.push('分离HEAD');
  if (w.ahead) t.push(`↑${w.ahead}`);
  if (w.behind) t.push(`↓${w.behind}`);
  if (w.extMissing) t.push(`缺扩展${w.extMissing}`);
  return t.length ? '  [' + t.join(' ') + ']' : '';
}

function renderWtList(d) {
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

function renderWt(w) {
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

const cdLine = (r) =>
  [`已${r.branch ? '创建' : '挂载'}: ${r.branch || r.name}`, `  路径: ${r.path}`, '', `cd "${r.path}"`].join('\n');

function renderRemove(r) {
  if (r.status === 'blocked') return `未删除: ${r.name} —— ${r.reason}`;
  const lines = [`已移除工作树: ${r.removed}`];
  if (r.branchDeleted) lines.push('关联分支已删除');
  if (r.branchKept) lines.push(`分支保留: ${r.branchKept}（${r.note}）`);
  return lines.join('\n');
}

function renderConfig(c) {
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

function renderInit(r) {
  const lines = ['工作树机制已就绪', `  主仓库: ${r.main}`];
  if (r.gitignoreAdded) lines.push(`  已登记 .gitignore: ${r.gitignoreAdded}`);
  lines.push(`  工作树根: ${r.config.worktreeRoot}`);
  lines.push('', '下一步: nx-rh wt add "<你要做的事>"');
  return lines.join('\n');
}

function renderContext(c) {
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

function renderExtList(d) {
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

function renderDiscover(d) {
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

function renderExtAdded(r) {
  return `已登记扩展文件: ${r.relPath}  [${r.kind}]${r.label ? '  (' + r.label + ')' : ''}`;
}

function renderExtUpdated(r) {
  return `已更新: ${r.relPath}${r.label ? '  (' + r.label + ')' : ''}`;
}

function renderExtRemoved(r) {
  return `已移除扩展文件登记: ${r.removed}（磁盘文件未动）`;
}

function renderSync(d) {
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

function renderRebase(r) {
  if (r.status === 'ok') return `已 rebase 到 ${r.base}: ${r.path}`;
  if (r.status === 'conflict') {
    return [`冲突，已自动 abort: ${r.path} -> ${r.base}`, r.output].join('\n');
  }
  return `未执行: ${r.path} —— ${r.reason}`;
}

function renderFanout(r) {
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

export default {
  id: 'worktrees',
  title: '工作树（= Web「工作树」页）',
  order: 15,
  view: () => import('./view.jsx'),

  actions: [
    {
      id: 'wt.init',
      cli: ['wt', 'init'],
      http: ['POST', '/api/wt/init'],
      summary: '初始化工作树机制：建根目录、按需登记 .gitignore',
      flags: {
        root: { type: 'string', hint: '工作树根目录' },
        'branch-prefix': { type: 'string' },
        'base-branch': { type: 'string' },
        'sync-mode': { type: 'string', hint: 'copy|symlink' },
      },
      run: (ctx) =>
        service.initWorktree({
          worktreeRoot: ctx.root,
          branchPrefix: ctx['branch-prefix'],
          baseBranch: ctx['base-branch'],
          syncMode: ctx['sync-mode'],
        }),
      render: renderInit,
    },
    {
      id: 'wt.config.get',
      cli: ['wt', 'config'],
      http: ['GET', '/api/wt/config'],
      summary: '查看工作树模块配置',
      run: () => service.getConfig(),
      render: renderConfig,
    },
    {
      id: 'wt.config.set',
      cli: ['wt', 'config', 'set'],
      http: ['PATCH', '/api/wt/config'],
      summary: '修改分支前缀 / 基础分支 / 工作树根 / 同步方式',
      flags: {
        root: { type: 'string', hint: '工作树根目录' },
        'branch-prefix': { type: 'string' },
        'base-branch': { type: 'string' },
        'sync-mode': { type: 'string', hint: 'copy|symlink' },
      },
      run: (ctx) =>
        service.setConfig({
          worktreeRoot: ctx.root,
          branchPrefix: ctx['branch-prefix'],
          baseBranch: ctx['base-branch'],
          syncMode: ctx['sync-mode'],
        }),
      render: renderConfig,
    },
    {
      id: 'wt.list',
      cli: ['wt', 'list'],
      http: ['GET', '/api/wt/list'],
      summary: '工作树清单（含改动 / 领先落后 / 缺扩展）',
      flags: { base: { type: 'string', hint: '基础分支' } },
      run: (ctx) => service.listWorktrees({ base: ctx.base }),
      render: renderWtList,
    },
    {
      id: 'wt.get',
      cli: ['wt', 'get'],
      http: ['GET', '/api/wt/:ref'],
      summary: '查看单个工作树详情（提交记录 / 扩展文件）',
      args: ['ref'],
      run: (ctx) => service.getWorktree(ctx.ref),
      render: renderWt,
    },
    {
      id: 'wt.add',
      cli: ['wt', 'add'],
      http: ['POST', '/api/wt'],
      summary: '描述要做的事，创建分支与工作树',
      args: ['description'],
      flags: {
        name: { type: 'string', hint: '自定义会话名' },
        base: { type: 'string', hint: '起点分支' },
        root: { type: 'string', hint: '工作树根覆盖' },
        force: { type: 'boolean' },
      },
      run: (ctx) => service.addWorktree(ctx),
      render: cdLine,
    },
    {
      id: 'wt.checkout',
      cli: ['wt', 'checkout'],
      http: ['POST', '/api/wt/checkout'],
      summary: '把已存在的分支挂成新工作树',
      args: ['branch'],
      flags: {
        name: { type: 'string' },
        root: { type: 'string' },
        force: { type: 'boolean' },
      },
      run: (ctx) => service.checkoutWorktree(ctx),
      render: cdLine,
    },
    {
      id: 'wt.remove',
      cli: ['wt', 'remove'],
      http: ['DELETE', '/api/wt/:ref'],
      summary: '移除工作树；--branch 连分支一起删，脏树需 --force',
      args: ['ref'],
      flags: { branch: { type: 'boolean' }, force: { type: 'boolean' } },
      run: (ctx) => service.removeWorktree(ctx.ref, { branch: ctx.branch === true, force: ctx.force === true }),
      render: renderRemove,
    },
    {
      id: 'wt.switch',
      cli: ['wt', 'switch'],
      http: ['POST', '/api/wt/switch'],
      summary: '取得进入工作树的 cd 指令',
      args: ['ref'],
      run: (ctx) => service.switchWorktree(ctx.ref),
      render: (r) => `cd "${r.path}"`,
    },
    {
      id: 'wt.open',
      cli: ['wt', 'open'],
      http: ['POST', '/api/wt/open'],
      summary: '在系统文件管理器中打开工作树',
      args: ['ref'],
      run: (ctx) => service.openWorktree(ctx.ref),
      render: (r) => `已打开: ${r.opened}`,
    },
    {
      id: 'wt.context',
      cli: ['wt', 'context'],
      http: ['GET', '/api/wt/context'],
      summary: '一次性获取主项目的最新 git 上下文（分支/改动/领先落后/扩展）',
      flags: { log: { type: 'number', default: 5, hint: '最近提交条数' } },
      run: (ctx) => service.getContext({ log: ctx.log }),
      render: renderContext,
    },
    {
      id: 'wt.rebase',
      cli: ['wt', 'rebase'],
      http: ['POST', '/api/wt/rebase'],
      summary: '把工作树 rebase 到主项目当前分支；脏树给 --message 自动提交',
      args: [{ name: 'ref', required: false }],
      flags: {
        base: { type: 'string', hint: '基础分支' },
        message: { type: 'string', hint: '自动提交信息' },
      },
      run: (ctx) => service.rebaseWorktree(ctx),
      render: renderRebase,
    },
    {
      id: 'wt.fanout',
      cli: ['wt', 'fanout'],
      http: ['POST', '/api/wt/fanout'],
      summary: '把主项目当前分支同步（rebase）到全部工作树；先出计划，--yes 执行',
      flags: {
        base: { type: 'string', hint: '基础分支' },
        yes: { type: 'boolean', hint: '执行计划' },
      },
      run: (ctx) => service.fanout({ base: ctx.base, yes: ctx.yes === true }),
      render: renderFanout,
    },
    {
      id: 'wt.ext.list',
      cli: ['wt', 'ext', 'list'],
      http: ['GET', '/api/wt/ext'],
      summary: '扩展文件清单及其在主项目/当前工作树的状态',
      flags: { target: { type: 'string', hint: '评估指定工作树' } },
      run: (ctx) => service.listExtensions({ target: ctx.target }),
      render: renderExtList,
    },
    {
      id: 'wt.ext.add',
      cli: ['wt', 'ext', 'add'],
      http: ['POST', '/api/wt/ext'],
      summary: '按全路径登记一个被 git 忽略的文件/目录为扩展文件',
      args: ['abspath'],
      flags: { label: { type: 'string' }, force: { type: 'boolean' } },
      run: (ctx) => service.addExtension(ctx),
      render: renderExtAdded,
    },
    {
      id: 'wt.ext.discover',
      cli: ['wt', 'ext', 'discover'],
      http: ['POST', '/api/wt/ext/discover'],
      summary: '从 .gitignore 与 git 发现被忽略文件；默认只建议，--apply 登记',
      flags: { apply: { type: 'boolean', hint: '登记全部候选' } },
      run: (ctx) => service.discoverExtensions({ apply: ctx.apply === true }),
      render: renderDiscover,
    },
    {
      id: 'wt.ext.get',
      cli: ['wt', 'ext', 'get'],
      http: ['GET', '/api/wt/ext/:ref'],
      summary: '查看单个扩展文件登记与当前状态',
      args: ['ref'],
      run: (ctx) => service.getExtension(ctx.ref),
      render: (r) => renderExtAdded(r),
    },
    {
      id: 'wt.ext.update',
      cli: ['wt', 'ext', 'update'],
      http: ['PATCH', '/api/wt/ext/:ref'],
      summary: '修改扩展文件标签',
      args: ['ref'],
      flags: { label: { type: 'string' } },
      run: (ctx) => service.updateExtension(ctx.ref, { label: ctx.label }),
      render: renderExtUpdated,
    },
    {
      id: 'wt.ext.remove',
      cli: ['wt', 'ext', 'remove'],
      http: ['DELETE', '/api/wt/ext/:ref'],
      summary: '移除扩展文件登记（磁盘不动）',
      args: ['ref'],
      run: (ctx) => service.removeExtension(ctx.ref),
      render: renderExtRemoved,
    },
    {
      id: 'wt.ext.sync',
      cli: ['wt', 'ext', 'sync'],
      http: ['POST', '/api/wt/ext/sync'],
      summary: '把扩展文件复制/链接进工作树；默认当前所在工作树',
      args: [{ name: 'target', required: false }],
      flags: {
        mode: { type: 'string', hint: 'copy|symlink' },
        ids: { type: 'array', hint: '只同步指定 id/路径' },
        force: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
      },
      run: (ctx) => service.syncExtensions(ctx),
      render: renderSync,
    },
  ],
};
