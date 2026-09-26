// 仓库模块：action 声明是 CLI 命令、HTTP 路由、help 文案的唯一来源。
// 加一条操作 = 在 actions 里加一项，三端同时获得它。
//
// 本模块只管**登记**：路径、名称、描述、标签、备注。
// git 状态 / diff / pull / push / resolve 一律不做——git 客户端是无底洞，
// 面板里做不出比 IDE 更好的体验，真要看状态直接用 git 自己（见 README「为什么不管 git」）。
import * as service from './service.js';

// ---- CLI 人读渲染（Web 端拿 JSON，用不到这些） ----
// 签名是 (data, ctx)：ctx 让渲染能引用入参。

function renderRepoList(list) {
  if (!list.length) return '（暂无仓库，用 repo add <path> 登记）';
  const lines = [`共 ${list.length} 个仓库`];
  for (const r of list) {
    lines.push(`${r.name.padEnd(18)} ${r.path}  ${r.tags.length ? '[' + r.tags.join(',') + ']' : ''}`);
  }
  return lines.join('\n');
}

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

export default {
  id: 'repos',
  title: '仓库登记（= Web「仓库」页）',
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
      summary: '查看单个仓库的登记信息',
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
      summary: '修改仓库路径 / 名称 / 描述 / 标签 / 备注',
      args: ['id'],
      flags: {
        path: { type: 'string' },
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
      summary: '扫描目录，发现仓库并登记（按 .git / 目录特征识别）',
      args: ['root'],
      flags: { depth: { type: 'number', default: 3 } },
      run: (ctx) => service.scanRepos(ctx.root, ctx.depth),
      render: (d) => `扫描 ${d.root}: 发现 ${d.scanned} 个仓库，新登记 ${d.added.length} 个`,
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
