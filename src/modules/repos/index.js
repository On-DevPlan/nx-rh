// 仓库模块：action 声明是 CLI 命令、HTTP 路由、help 文案的唯一来源。
// 加一条操作 = 在 actions 里加一项，三端同时获得它。
//
// 本模块只管**登记**：路径、名称、描述、标签、备注。
// git 状态 / diff / pull / push / resolve 一律不做——git 客户端是无底洞，
// 面板里做不出比 IDE 更好的体验，真要看状态直接用 git 自己（见 README「为什么不管 git」）。
import * as service from './service.js';
import * as boards from './boards.js';
import { badInput } from '../../core/errors.js';

// ---- 看板的 CLI 人读渲染 ----
// 用户要的「快速判断看板里的 repo 和 desc」：按主题分组，一行 = 仓库名 + 一句话描述。
function renderBoardList(d) {
  const lines = [];
  for (const b of d.boards) {
    lines.push(`【${b.name}】${b.repos.length} 个仓库${b.desc ? ` —— ${b.desc}` : ''}`);
    for (const r of b.repos) lines.push(`  ${r.name.padEnd(18)} ${r.desc || '-'}`);
  }
  if (d.unassigned.length) {
    lines.push('【未分组】');
    for (const r of d.unassigned) lines.push(`  ${r.name.padEnd(18)} ${r.desc || '-'}`);
  }
  if (!lines.length) return '（还没有看板与仓库，用 board add <名称> 建主题、repo add 登记仓库）';
  return lines.join('\n');
}

function renderBoard(b) {
  const lines = [`【${b.name}】${b.desc || ''} —— ${b.repos.length} 个仓库`];
  for (const r of b.repos) lines.push(`  ${r.name.padEnd(18)} ${r.desc || '-'}`);
  return lines.join('\n');
}

const lastSeg = (p) => String(p || '').replace(/\\/g, '/').split('/').filter(Boolean).slice(-1)[0] || '';

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
      summary: '扫描目录发现 git 仓库；--dry-run 只列出（发现模式，不登记）',
      // root 缺省当前目录：最常见的用法就是「看看我现在这个目录下面都有些什么仓库」
      args: [{ name: 'root', required: false }],
      flags: {
        depth: { type: 'number', default: 3 },
        'dry-run': { type: 'boolean', hint: '只列出发现的仓库，不登记' },
      },
      run: (ctx) => service.scanRepos(ctx.root || process.cwd(), ctx.depth, { dryRun: ctx['dry-run'] === true }),
      render: (d) => {
        const head = `${d.dryRun ? '发现（未登记）' : '扫描'} ${d.root}: ${d.scanned} 个 git 仓库`;
        if (!d.scanned) return `${head}\n（这个深度下没有找到）`;
        const lines = [head];
        for (const r of d.found) {
          lines.push(`  ${r.known ? '已登记' : '未登记'}  ${r.path}${r.name && r.name !== lastSeg(r.path) ? `  (${r.name})` : ''}`);
        }
        if (d.dryRun) {
          lines.push('', `确认要收进来的用: nx-rh repo add <path> --desc "一句话描述"`);
          lines.push('（`repo scan` 不带 --dry-run 会直接登记全部）');
        } else {
          lines.push('', `新登记 ${d.added.length} 个${d.skipped ? `，已在册 ${d.skipped} 个` : ''}`);
        }
        return lines.join('\n');
      },
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

    // ---- 看板（主题容器）：多项目编排层，面板与 CLI 同源 ----
    {
      id: 'board.list',
      cli: ['board', 'list'],
      http: ['GET', '/api/boards'],
      summary: '看板清单：每个主题里有哪些仓库、各自的一句话描述',
      run: () => boards.listBoards(),
      render: renderBoardList,
    },
    {
      id: 'board.get',
      cli: ['board', 'get'],
      http: ['GET', '/api/boards/:id'],
      summary: '查看单个看板（含成员仓库与描述）',
      args: ['id'],
      run: (ctx) => boards.getBoard(ctx.id),
      render: renderBoard,
    },
    {
      id: 'board.add',
      cli: ['board', 'add'],
      http: ['POST', '/api/boards'],
      summary: '新建看板（主题容器）',
      args: ['name'],
      flags: { desc: { type: 'string' } },
      run: (ctx) => boards.createBoard(ctx),
      render: (b) => `已新建看板: ${b.name}`,
    },
    {
      id: 'board.update',
      cli: ['board', 'update'],
      http: ['PATCH', '/api/boards/:id'],
      summary: '改看板名称 / 描述',
      args: ['id'],
      flags: {
        name: { type: 'string' },
        desc: { type: 'string' },
      },
      run: (ctx) => boards.updateBoard(ctx.id, ctx),
      render: (b) => `已更新看板: ${b.name}`,
    },
    {
      id: 'board.remove',
      cli: ['board', 'remove'],
      http: ['DELETE', '/api/boards/:id'],
      summary: '删看板（里面的仓库回到未分组，登记不动）',
      args: ['id'],
      run: (ctx) => boards.removeBoard(ctx.id),
      render: (d) => `已删除看板: ${d.removed}（${d.released} 个仓库回到未分组）`,
    },
    {
      id: 'board.assign',
      cli: ['board', 'assign'],
      http: ['POST', '/api/boards/assign'],
      summary: '把仓库放进看板（board 留空 = 移回未分组；--before 插到某卡片前）',
      args: ['id'],
      flags: {
        board: { type: 'string', hint: '目标看板 id；留空 = 未分组' },
        before: { type: 'string', hint: '插到这张卡片之前' },
      },
      run: (ctx) => boards.assignRepo(ctx),
      render: (d) => `已移动: ${d.name}`,
    },
    {
      id: 'board.import',
      cli: ['board', 'import'],
      http: ['POST', '/api/boards/import'],
      summary: '导入看板 JSON（一个看板 = 一个主题；按 path/name 匹配已登记仓库）',
      // 两种入口同一条 action：CLI 给文件路径（- = stdin），面板直接 POST {json}。
      // file 因此不能是必填——否则面板那条路会先被「缺少参数」拦掉（真踩过：400）。
      args: [{ name: 'file', required: false }],
      run: async (ctx) => {
        let json = typeof ctx.json === 'string' ? ctx.json : '';
        if (!json && ctx.file) {
          const { readFileSync } = await import('node:fs');
          json = readFileSync(ctx.file === '-' ? 0 : ctx.file, 'utf8');
        }
        if (!json) throw badInput('请给看板 JSON 文件路径（- 读 stdin），或在面板里粘贴 JSON');
        return boards.importBoards({ json });
      },
      render: (d) => {
        const lines = [`新建 ${d.created} 个看板，合并 ${d.merged} 个，匹配仓库 ${d.matched} 个`];
        if (d.unmatched.length) {
          lines.push('未匹配（登记里找不到，未导入）:');
          for (const u of d.unmatched) lines.push(`  [${u.board}] ${u.entry}`);
        }
        return lines.join('\n');
      },
    },
    {
      id: 'board.export',
      cli: ['board', 'export'],
      http: ['GET', '/api/boards/export'],
      summary: '导出看板 JSON（可回灌给 board import）',
      run: () => boards.exportBoards(),
      render: (d) => JSON.stringify(d, null, 2),
    },
  ],
};
