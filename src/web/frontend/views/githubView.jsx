// GitHub 页：gh CLI 连接器（概览 / 搜索 / 我的仓库）。
import { useState } from 'react';
import { api } from '../api/client.js';
import { useGuard } from '../components/ui.jsx';

export default function GithubView() {
  const guard = useGuard();
  const [status, setStatus] = useState('');
  const [repoInput, setRepoInput] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [limit, setLimit] = useState('10');
  const [overview, setOverview] = useState(null);
  const [results, setResults] = useState(null);

  const loadStatus = () => guard(async () => {
    try {
      const s = await api('/api/gh/status');
      setStatus(s.available ? 'gh 已登录' : 'gh 未就绪');
    } catch {
      setStatus('gh 检查失败');
    }
  });

  const viewRepo = (repo) => guard(async () => {
    if (!repo) return;
    setResults(null);
    setOverview(await api('/api/gh/view?repo=' + encodeURIComponent(repo)));
  });

  const doSearch = () => guard(async () => {
    if (!searchInput.trim()) return;
    setOverview(null);
    setResults(await api('/api/gh/search?q=' + encodeURIComponent(searchInput.trim()) + '&limit=' + (parseInt(limit, 10) || 10)));
  });

  const mine = () => guard(async () => {
    setOverview(null);
    setResults(await api('/api/gh/mine?limit=30'));
  });

  const fmtDate = (s) => String(s || '').slice(0, 10);

  return (
    <>
      <div className="toolbar">
        <input placeholder="owner/repo 或 GitHub URL" size="30" spellCheck="false" value={repoInput}
          onChange={(e) => setRepoInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') viewRepo(repoInput.trim()); }} />
        <button className="btn" onClick={() => viewRepo(repoInput.trim())}>查看概览</button>
        <span className="sep"></span>
        <input placeholder="搜索关键词" size="20" spellCheck="false" value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') doSearch(); }} />
        <input placeholder="数量" size="3" value={limit} onChange={(e) => setLimit(e.target.value)} />
        <button className="btn" onClick={doSearch}>搜索</button>
        <button className="btn ghost" onClick={mine}>我的仓库</button>
        <span className="muted" style={{ marginLeft: 8 }}>{status}</span>
        <button className="btn small ghost" onClick={loadStatus}>检查 gh</button>
      </div>

      {overview ? (
        <div className="card">
          <div className="colhead">
            <h3><a href={overview.url} target="_blank" rel="noreferrer">{overview.nameWithOwner}</a>{' '}
              <span className="muted">
                {[overview.isPrivate && 'private', overview.isArchived && 'archived', overview.isFork && 'fork'].filter(Boolean).join(' ')}
              </span>
            </h3>
            <span className="muted">{overview.primaryLanguage || '-'}</span>
          </div>
          <div style={{ padding: '12px 16px' }}>
            <div style={{ marginBottom: 8 }}>{overview.description || '（无描述）'}</div>
            <div className="settings">
              <dt>Stars</dt><dd>{overview.stargazersCount}</dd>
              <dt>Forks</dt><dd>{overview.forkCount}</dd>
              <dt>Watchers</dt><dd>{overview.watchers}</dd>
              <dt>Open Issues</dt><dd>{overview.openIssues}</dd>
              <dt>Open PRs</dt><dd>{overview.pullRequests}</dd>
              <dt>默认分支</dt><dd>{overview.defaultBranch || '-'}</dd>
              <dt>License</dt><dd>{overview.license || '-'}</dd>
              <dt>最新版本</dt><dd>{overview.latestRelease || '-'}</dd>
              <dt>创建时间</dt><dd>{fmtDate(overview.createdAt)}</dd>
              <dt>更新时间</dt><dd>{fmtDate(overview.updatedAt)}</dd>
              <dt>推送时间</dt><dd>{fmtDate(overview.pushedAt)}</dd>
              <dt>语言</dt><dd>{(overview.languages || []).join(', ') || overview.primaryLanguage || '-'}</dd>
              {overview.homepageUrl ? <><dt>主页</dt><dd><a href={overview.homepageUrl} target="_blank" rel="noreferrer">{overview.homepageUrl}</a></dd></> : null}
            </div>
            {overview.topics?.length ? <div className="muted" style={{ marginTop: 6 }}>主题: {overview.topics.join(', ')}</div> : null}
          </div>
        </div>
      ) : null}

      {results ? (
        <div className="card">
          <table>
            <thead><tr>
              <th style={{ width: 80 }}>Stars</th><th style={{ width: 100 }}>语言</th><th>仓库</th><th>描述</th><th style={{ width: 100 }}>更新</th>
            </tr></thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.nameWithOwner}>
                  <td>{r.stargazersCount}</td>
                  <td>{r.primaryLanguage || '-'}</td>
                  <td><a href={r.url} target="_blank" rel="noreferrer"
                    onClick={(e) => { e.preventDefault(); setRepoInput(r.nameWithOwner); viewRepo(r.nameWithOwner); }}>
                    {r.nameWithOwner}
                  </a></td>
                  <td>{(r.description || '').slice(0, 60)}</td>
                  <td>{fmtDate(r.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="cli-hint">CLI 等价：nx-rh gh view &lt;owner/repo&gt; · nx-rh gh search &lt;query&gt; · nx-rh gh mine</div>
    </>
  );
}
