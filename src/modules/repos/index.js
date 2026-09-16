// 仓库模块：action 声明是 CLI 命令、HTTP 路由、help 文案的唯一来源。
// 加一条操作 = 在 actions 里加一项，三端同时获得它。
import * as service from './service.js';

// ---- CLI 人读渲染（Web 端拿 JSON，用不到这些） ----
// 签名是 (data, ctx)：ctx 让渲染能引用入参（如 repo resolve 要用 --file/--side）。

function renderRepoList(list) {
  if (!list.length) return '（暂无仓库，用 repo add <path> 登记）';
  const lines = [`共 ${list.length} 个仓库`];
  for (const r of list) {
    lines.push(`${r.name.padEnd(18)} ${r.path}  ${r.tags.length ? '[' + r.tags.join(',') + ']' : ''}`);
  }
  return lines.join('\n');
}

// 单条仓库的登记信息（对应 repo.get）。刻意不跑 git——那是 repo.status 的事。
function renderRepo(r) {
  const lines = [
    `${r.name}${r.desc ? '  ' + r.desc : ''}`,
    `  id:    ${r.id}`,
    `  路径:  ${r.path}`,
    `  标签:  ${r.tags.length ? r.tags.join(', ') : '-'}`,
    `  登记:  ${(r.addedAt || '').slice(0, 10)}`,
    `  更新:  ${(r.updatedAt || '').slice(0, 10)}`,
  ];
  if (r.notes) lines.push('  备注:  ' + r.notes);
  return lines.join('\n');
}

function renderStatus(list) {
  return list
    .map((r) => {
      const g = r.git;
      if (g.error) return `[${r.name}] 非 git 仓库`;
      const parts = [
        `[${r.name}] 分支 ${g.branch}`,
        `领先 ${g.ahead} 落后 ${g.behind}`,
        `暂存 ${g.staged.length} 修改 ${g.modified.length} 未跟踪 ${g.untracked.length}`,
      ];
      let line = parts.join(' · ');
      if (g.conflicted.length) line += ` · 冲突 ${g.conflicted.length} 个文件: ${g.conflicted.join(', ')}`;
      else if (g.clean) line += ' · 干净';
      return line;
    })
    .join('\n');
}

export default {
  id: 'repos',
  title: '仓库管理（= Web「仓库」页）',
  order: 10,
  view: () => import('./view.jsx'),

  // CRUD 完备性声明：本模块管理的是一组「仓库」实体，因此必须齐备五个操作，
  // 且每个都要能从 CLI 与 HTTP 两端调用。
  //   增 repo.add    查(列表) repo.list   查(单条) repo.get
  //   改 repo.update 删 repo.remove
  // tests/unit/registry.test.mjs 据此断言——漏一个、或某个操作缺了某端，直接测试失败。
  resource: 'repo',

  actions: [
    {
      id: 'repo.list',
      cli: ['repo', 'list'],
      http: ['GET', '/api/repos'],
      summary: '仓库清单',
      run: () => service.listRepos(),
      render: renderRepoList,
    },
    {
      id: 'repo.get',
      cli: ['repo', 'get'],
      http: ['GET', '/api/repos/:id'],
      summary: '查看单个仓库的登记信息（不跑 git）',
      args: ['id'],
      run: (ctx) => service.getRepo(ctx.id),
      render: renderRepo,
    },
    {
      id: 'repo.add',
      cli: ['repo', 'add'],
      http: ['POST', '/api/repos'],
      summary: '登记一个仓库',
      args: ['path'],
      flags: {
        name: { type: 'string' },
        desc: { type: 'string' },
        tags: { type: 'array' },
        notes: { type: 'string' },
      },
      run: (ctx) => service.addRepo(ctx),
      render: (r) => `已登记: ${r.name} -> ${r.path}`,
    },
    {
      id: 'repo.update',
      cli: ['repo', 'update'],
      http: ['PATCH', '/api/repos/:id'],
      summary: '修改仓库名称 / 描述 / 标签 / 备注',
      args: ['id'],
      flags: {
        name: { type: 'string' },
        desc: { type: 'string' },
        tags: { type: 'array' },
        notes: { type: 'string' },
      },
      run: (ctx) => service.updateRepo(ctx.id, ctx),
      render: (r) => `已更新: ${r.name}`,
    },
    {
      id: 'repo.remove',
      cli: ['repo', 'remove'],
      http: ['DELETE', '/api/repos/:id'],
      summary: '移除登记（不动磁盘文件）',
      args: ['id'],
      run: (ctx) => service.removeRepo(ctx.id),
      render: (r) => `已移除登记: ${r.name}（磁盘文件未动）`,
    },
    {
      id: 'repo.scan',
      cli: ['repo', 'scan'],
      http: ['POST', '/api/repos/scan'],
      summary: '扫描目录，发现 git 仓库并登记',
      args: ['root'],
      flags: { depth: { type: 'number', default: 3 } },
      run: (ctx) => service.scanRepos(ctx.root, ctx.depth),
      render: (d) => `扫描 ${d.root}: 发现 ${d.scanned} 个 git 仓库，新登记 ${d.added.length} 个`,
    },
    {
      id: 'repo.status',
      cli: ['repo', 'status'],
      http: ['GET', '/api/repos/status'],
      summary: 'git 状态（分支 / 领先落后 / 变更 / 冲突）',
      args: [{ name: 'id', required: false }],
      run: (ctx) => service.repoStatus(ctx.id),
      render: renderStatus,
    },
    {
      id: 'repo.diff',
      cli: ['repo', 'diff'],
      http: ['GET', '/api/repos/diff'],
      summary: '未暂存差异文本',
      args: ['id'],
      flags: { file: { type: 'string' } },
      run: (ctx) => service.repoDiff(ctx.id, ctx.file),
      render: (d) => d,
    },
    {
      id: 'repo.pull',
      cli: ['repo', 'pull'],
      http: ['POST', '/api/repos/pull'],
      summary: 'fetch + pull（有冲突时列出文件）',
      args: ['id'],
      run: (ctx) => service.repoPull(ctx.id),
      render: (d) =>
        d.output + (d.conflicted.length ? `\n冲突文件: ${d.conflicted.join(', ')}` : ''),
    },
    {
      id: 'repo.push',
      cli: ['repo', 'push'],
      http: ['POST', '/api/repos/push'],
      summary: '推送到远端',
      args: ['id'],
      run: (ctx) => service.repoPush(ctx.id),
      render: (d) => d.output || '推送完成',
    },
    {
      id: 'repo.resolve',
      cli: ['repo', 'resolve'],
      http: ['POST', '/api/repos/resolve'],
      summary: '落地单个冲突文件（选一侧）',
      args: ['id'],
      flags: {
        file: { type: 'string', required: true },
        side: { type: 'string', required: true, enum: ['ours', 'theirs'] },
      },
      run: (ctx) => service.repoResolve(ctx.id, ctx.file, ctx.side),
      render: (d, ctx) => `已按 ${ctx.side} 落地并暂存: ${ctx.file}`,
    },
    {
      id: 'repo.open',
      cli: ['repo', 'open'],
      http: ['POST', '/api/repos/open'],
      summary: '在系统文件管理器中打开',
      args: ['id'],
      run: (ctx) => service.repoOpen(ctx.id),
      render: (d) => `已打开: ${d.opened}`,
    },
  ],
};
