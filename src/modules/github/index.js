// GitHub 连接器模块（= Web「GitHub」页）。依赖外部 gh CLI，需要用户已登录。
import * as service from './service.js';

function renderOverview(r) {
  const lines = [
    r.nameWithOwner + (r.isPrivate ? '  [private]' : '') + (r.isArchived ? '  [archived]' : ''),
    r.description || '（无描述）',
    '',
    '  语言:     ' + (r.primaryLanguage || '-') + (r.languages.length ? '  (' + r.languages.join(', ') + ')' : ''),
    '  Stars:    ' + r.stargazersCount,
    '  Forks:    ' + r.forkCount,
    '  Watchers: ' + r.watchers,
    '  Issues:   ' + r.openIssues + '  PR: ' + r.pullRequests,
    '  默认分支: ' + (r.defaultBranch || '-'),
    '  License:  ' + (r.license || '-'),
    '  创建:     ' + (r.createdAt || '').slice(0, 10),
    '  更新:     ' + (r.updatedAt || '').slice(0, 10),
    '  推送:     ' + (r.pushedAt || '').slice(0, 10),
    '  最新版本: ' + (r.latestRelease || '-'),
    '  URL:      ' + r.url,
  ];
  if (r.homepageUrl) lines.push('  主页:     ' + r.homepageUrl);
  if (r.topics.length) lines.push('  主题:     ' + r.topics.join(', '));
  return lines.join('\n');
}

function renderList(list) {
  if (!list.length) return '（无结果）';
  const lines = ['找到 ' + list.length + ' 个仓库:'];
  for (const r of list) {
    const star = String(r.stargazersCount).padStart(6);
    const lang = (r.primaryLanguage || '-').padEnd(12);
    lines.push('  ' + star + ' stars  ' + lang + '  ' + r.nameWithOwner + '  ' + (r.description || '').slice(0, 50));
  }
  return lines.join('\n');
}

export default {
  id: 'github',
  title: 'GitHub 连接器（= Web「GitHub」页，需已安装 gh 并登录）',
  order: 30,
  view: () => import('./view.jsx'),

  actions: [
    {
      id: 'gh.status',
      cli: ['gh', 'status'],
      http: ['GET', '/api/gh/status'],
      summary: '检查 gh 可用性与登录态',
      run: () => service.ghStatus(),
      render: (d) => (d.available ? 'gh 可用:\n' + d.message : 'gh 不可用:\n' + d.message),
    },
    {
      id: 'gh.view',
      cli: ['gh', 'view'],
      http: ['GET', '/api/gh/view'],
      summary: '查看仓库概览',
      args: ['repo'],
      run: (ctx) => service.viewRepo(ctx.repo),
      render: renderOverview,
    },
    {
      id: 'gh.search',
      cli: ['gh', 'search'],
      http: ['GET', '/api/gh/search'],
      summary: '搜索 GitHub 仓库',
      // CLI 的查询词可能是多个 token（gh search foo bar），HTTP 侧是单个 q 参数
      args: [{ name: 'q', rest: true }],
      flags: { limit: { type: 'number', default: 10 } },
      run: (ctx) => service.searchRepos(Array.isArray(ctx.q) ? ctx.q.join(' ') : ctx.q, ctx.limit),
      render: renderList,
    },
    {
      id: 'gh.mine',
      cli: ['gh', 'mine'],
      http: ['GET', '/api/gh/mine'],
      summary: '列出当前用户的仓库',
      flags: { limit: { type: 'number', default: 30 } },
      run: (ctx) => service.listMyRepos(ctx.limit),
      render: renderList,
    },
  ],
};
