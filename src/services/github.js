// GitHub 连接器：通过 gh CLI 查询仓库概览与搜索。
// 零依赖：直接 spawn gh 命令，复用用户已有的登录态与配置。
import { spawn } from 'node:child_process';

function runGh(args, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('gh 命令超时（' + timeoutMs + 'ms）'));
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') reject(new Error('未找到 gh 命令，请先安装 GitHub CLI 并登录（gh auth login）'));
      else reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || 'gh 退出码 ' + code));
    });
  });
}

// 规范化 owner/repo 输入：支持 "owner/repo"、完整 URL、纯 repo 名（需配合 --owner）
function parseRepo(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('仓库标识不能为空（格式: owner/repo）');
  // 去掉 URL 前缀
  s = s.replace(/^https?:\/\/github\.com\//, '');
  s = s.replace(/^git@github\.com:/, '');
  s = s.replace(/\.git$/, '');
  s = s.replace(/\/$/, '');
  const parts = s.split('/').filter(Boolean);
  if (parts.length < 2) throw new Error('格式应为 owner/repo，收到: ' + input);
  return parts.slice(0, 2).join('/');
}

const REPO_FIELDS = [
  'name', 'nameWithOwner', 'description', 'url', 'homepageUrl',
  'stargazerCount', 'forkCount', 'watchers', 'issues', 'pullRequests',
  'primaryLanguage', 'languages', 'defaultBranchRef', 'licenseInfo',
  'createdAt', 'updatedAt', 'pushedAt', 'isArchived', 'isFork', 'isPrivate',
  'repositoryTopics', 'latestRelease',
];

// 查看单个仓库概览
export async function viewRepo(input) {
  const repo = parseRepo(input);
  const json = await runGh([
    'repo', 'view', repo,
    '--json', REPO_FIELDS.join(','),
  ]);
  const raw = JSON.parse(json);
  return normalizeRepo(raw);
}

// 搜索仓库
export async function searchRepos(query, limit = 10) {
  const q = String(query || '').trim();
  if (!q) throw new Error('搜索关键词不能为空');
  const n = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 30);
  const json = await runGh([
    'search', 'repos', q,
    '--limit', String(n),
    '--json', 'name,owner,description,url,stargazersCount,forksCount,language,updatedAt,isArchived,isPrivate',
  ]);
  const list = JSON.parse(json);
  return list.map((r) => ({
    name: r.name,
    owner: r.owner && r.owner.login,
    nameWithOwner: (r.owner && r.owner.login ? r.owner.login + '/' : '') + r.name,
    description: r.description || '',
    url: r.url,
    stargazersCount: r.stargazersCount || 0,
    forkCount: r.forksCount || 0,
    primaryLanguage: r.language || null,
    updatedAt: r.updatedAt,
    isArchived: !!r.isArchived,
    isPrivate: !!r.isPrivate,
  }));
}

// 列出当前用户的仓库（可选）
export async function listMyRepos(limit = 30) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100);
  const json = await runGh([
    'repo', 'list',
    '--limit', String(n),
    '--json', 'name,owner,description,url,stargazerCount,forkCount,primaryLanguage,updatedAt',
  ]);
  const list = JSON.parse(json);
  return list.map((r) => ({
    name: r.name,
    owner: r.owner && r.owner.login,
    nameWithOwner: (r.owner && r.owner.login ? r.owner.login + '/' : '') + r.name,
    description: r.description || '',
    url: r.url,
    stargazersCount: r.stargazerCount || 0,
    forkCount: r.forkCount || 0,
    primaryLanguage: r.primaryLanguage && r.primaryLanguage.name ? r.primaryLanguage.name : null,
    updatedAt: r.updatedAt,
  }));
}

// 检查 gh 是否可用且已登录
export async function ghStatus() {
  try {
    const out = await runGh(['auth', 'status']);
    return { available: true, message: out };
  } catch (err) {
    return { available: false, message: String(err && err.message || err) };
  }
}

// ---- 内部：把 gh 返回的嵌套结构拍平成概览对象 ----

function normalizeRepo(r) {
  const lang = r.primaryLanguage && r.primaryLanguage.name ? r.primaryLanguage.name : null;
  const languages = Array.isArray(r.languages)
    ? r.languages.map((l) => l && l.name).filter(Boolean)
    : [];
  const topics = Array.isArray(r.repositoryTopics)
    ? r.repositoryTopics.map((t) => t && t.topic && t.topic.name).filter(Boolean)
    : [];
  return {
    name: r.name,
    nameWithOwner: r.nameWithOwner,
    description: r.description || '',
    url: r.url,
    homepageUrl: r.homepageUrl || '',
    stargazersCount: r.stargazerCount || 0,
    forkCount: r.forkCount || 0,
    watchers: r.watchers && r.watchers.totalCount ? r.watchers.totalCount : 0,
    openIssues: r.issues && r.issues.totalCount ? r.issues.totalCount : 0,
    pullRequests: r.pullRequests && r.pullRequests.totalCount ? r.pullRequests.totalCount : 0,
    primaryLanguage: lang,
    languages,
    defaultBranch: r.defaultBranchRef && r.defaultBranchRef.name ? r.defaultBranchRef.name : null,
    license: r.licenseInfo && r.licenseInfo.spdxId ? r.licenseInfo.spdxId : (r.licenseInfo && r.licenseInfo.name ? r.licenseInfo.name : null),
    topics,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    pushedAt: r.pushedAt,
    isArchived: !!r.isArchived,
    isFork: !!r.isFork,
    isPrivate: !!r.isPrivate,
    latestRelease: r.latestRelease && r.latestRelease.tagName ? r.latestRelease.tagName : null,
  };
}
