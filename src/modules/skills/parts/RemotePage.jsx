// ② 级子页：远程订阅源管理（#remote）。与其他子页同构——
//   面包屑 + sub-head + section-label/entry-grid 卡片 + 显式按钮触发的搜索。
//   数据全走既有 action：源卡片用 /api/skills（sources 自带 remote 元数据），
//   同步 POST /api/skills/sync（--dry-run 先预演再确认，与 purge 同款高危流），
//   搜索 GET /api/skills/search，订阅 POST /api/skills/sources（自动识别远程规格）。
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../web/frontend/api/client.js';
import { useStore } from '../../../web/frontend/store.jsx';
import { useToast, useGuard, useDialog, Modal, Copyable } from '../../../web/frontend/components/ui.jsx';
import { CliHints } from '../../../web/frontend/components/CliHints.jsx';
import { useSkillsData, Crumbs } from './shared.jsx';
import { goHub } from './routes.js';

// 「X 前」相对时间（与注册表页一致的人读形态；fetchedAt 是 ISO 串）
function ago(iso) {
  if (!iso) return '—';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

// 同步结果（单源或全部）→ 弹窗行清单；文案对齐 CLI renderSync
function SyncReportBody({ report, onClose }) {
  const rows = report?.results || [];
  return (
    <>
      {report?.dryRun ? <div className="dlg-msg">预演（未改动磁盘）:</div> : null}
      <div className="list">
        {rows.map((r) => (
          <div key={r.source} className="row">
            <div className="name mono">{r.spec || r.source}</div>
            <div className="desc">
              {r.error
                ? <span className="tag bad">失败</span>
                : r.clean
                  ? <span className="tag">无变化</span>
                  : [
                      r.added?.length ? <span key="a" className="tag">+{r.added.length} 新增</span> : null,
                      r.removed?.length ? <span key="r" className="tag">-{r.removed.length} 移除</span> : null,
                      r.changed?.length ? <span key="c" className="tag">~{r.changed.length} 变更</span> : null,
                    ]}
              {r.error ? <span> {r.error}</span> : null}
              {!r.error && (r.added?.length || r.removed?.length || r.changed?.length)
                ? <span> {r.added?.join(', ')}{r.removed?.join(', ')}{r.changed?.join(', ')}</span> : null}
            </div>
          </div>
        ))}
        {!rows.length ? <div className="muted">（没有远程订阅源）</div> : null}
      </div>
      <div className="dlg-acts"><button className="btn" onClick={onClose}>知道了</button></div>
    </>
  );
}

export function RemotePage({ tick }) {
  const { data, reload } = useSkillsData({}, tick);
  const { refreshBoot } = useStore();
  const toast = useToast();
  const guard = useGuard();
  const { dialog, node: dlgNode } = useDialog();

  const [busyId, setBusyId] = useState('');          // 逐源操作门闩（键 = 源路径）
  const [busyAll, setBusyAll] = useState(false);
  const [syncReport, setSyncReport] = useState(null); // { dryRun, results } | { results, source? }
  const [pendingSync, setPendingSync] = useState(null); // dry-run 通过后待确认的源（'' = 全部）
  const [q, setQ] = useState('');
  const [owner, setOwner] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState(null);       // null = 还没搜过
  const [subscribing, setSubscribing] = useState(''); // 正在订阅的 source

  const sources = (data?.sources || []).filter((s) => s.remote);

  const doReload = useCallback(async () => { await reload(); await refreshBoot(); }, [reload, refreshBoot]);

  // ---- 同步：先 dry-run 预演 → 确认后真跑（与 purge 同款高危流） ----
  const runSync = (source, dryRun) => guard(async () => {
    const r = await api('/api/skills/sync', {
      method: 'POST',
      body: { ...(source ? { source } : {}), 'dry-run': dryRun },
      timeoutMs: 300000,
    });
    if (dryRun) {
      const anyChange = (r.results || []).some((x) => !x.error && !x.clean);
      setSyncReport({ dryRun: true, results: r.results });
      if (anyChange) {
        const ok = await dialog({ title: '确认同步', message: '预演发现有变化，确认拉新并换入？', okText: '同步' });
        if (ok) setPendingSync(source || '');
      }
      return;
    }
    setSyncReport({ results: r.results });
    await doReload();
  });

  const syncOne = (s) => guard(async () => {
    if (busyId || busyAll) return;
    setBusyId(s.path);
    try { await runSync(s.remote.spec, true); } finally { setBusyId(''); }
  });

  const syncAll = () => guard(async () => {
    if (busyAll || busyId) return;
    setBusyAll(true);
    try { await runSync('', true); } finally { setBusyAll(false); }
  });

  // pendingSync 由确认弹窗设置（'' = 全部）；effect 里真跑，避开在 dialog 回调里套 guard
  useEffect(() => {
    if (pendingSync === null) return;
    const src = pendingSync;
    setPendingSync(null);
    guard(async () => {
      setBusyAll(true);
      try {
        const r = await api('/api/skills/sync', { method: 'POST', body: { ...(src ? { source: src } : {}) }, timeoutMs: 300000 });
        setSyncReport({ results: r.results });
        await doReload();
      } finally { setBusyAll(false); }
    });
  }, [pendingSync]);

  const unsubscribe = (s) => guard(async () => {
    const ok = await dialog({
      title: '取消订阅远程源',
      message: `不再订阅：${s.remote.spec}\n${s.path}\n\n磁盘副本保留（~/.nx-rh/remote-skills/），重新订阅会原地刷新。`,
      danger: true,
      okText: '退订',
    });
    if (!ok) return;
    await api('/api/skills/sources', { method: 'DELETE', body: { path: s.path } });
    toast(`已退订 ${s.remote.spec}`);
    await doReload();
  });

  // ---- 订阅：输入框收目录或远程规格（action 自动识别）；克隆慢，超时放宽 ----
  const subscribe = (presetSpec) => guard(async () => {
    const spec = presetSpec || await dialog({
      title: '订阅远程源',
      input: true,
      placeholder: 'owner/repo · git URL · 归档 URL',
      message: '支持 GitHub 简写 / tree 子路径 / #ref / 任意 git / 归档与单 SKILL.md URL。\n订阅后将成为主源。',
    });
    if (!spec) return;
    setSubscribing(spec);
    try {
      const r = await api('/api/skills/sources', { method: 'POST', body: { path: spec }, timeoutMs: 120000 });
      toast(`已订阅 ${spec}（${r.count ?? '?'} 个 skill）`);
      await doReload();
    } finally { setSubscribing(''); }
  });

  // ---- 搜索：显式按钮/回车触发（网络请求不做输入即搜） ----
  const doSearch = () => guard(async () => {
    if (searching) return;
    if (!q.trim()) { toast('先输入关键词'); return; }
    setSearching(true);
    try {
      const qs = new URLSearchParams({ q });
      if (owner.trim()) qs.set('owner', owner.trim());
      const r = await api('/api/skills/search?' + qs.toString(), { timeoutMs: 30000 });
      setResults(r.results || []);
    } finally { setSearching(false); }
  });

  return (
    <>
      <Crumbs trail={[{ label: '远程源' }]} />
      <div className="sub-head">
        <div>
          <div style={{ fontSize: 15, fontWeight: 700 }}>远程源</div>
          <div className="sub-meta">订阅外部 skill 仓库 · 上游更新靠同步拉新（本地流程不变）</div>
        </div>
        <div className="acts">
          <button className="btn ghost" onClick={syncAll} disabled={busyAll || busyId || !sources.length}>
            {busyAll ? '同步中…' : '全部同步'}
          </button>
          <button className="btn" onClick={() => subscribe('')}>{subscribing ? '订阅中…' : '＋ 订阅远程源…'}</button>
        </div>
      </div>

      <div className="section-label">远程订阅源
        <span className="hint">{sources.length} 个 · 落位 ~/.nx-rh/remote-skills/ · 点卡片看该源的 skill</span>
      </div>
      <div className="entry-grid">
        {sources.map((s) => {
          const snapCount = s.remote.skills ? Object.keys(s.remote.skills).length : null;
          const drifted = snapCount !== null && snapCount !== s.count;
          return (
            <div key={s.path} className="entry-card" onClick={() => goHub(s.path)}>
              <div className="ec-top">
                <span className="ec-name" title={s.remote.spec}>{s.remote.spec}</span>
                {s.current ? <span className="tag strong">主源</span> : null}
                {s.remote.ref ? <span className="tag">@{s.remote.ref}</span> : null}
                {drifted ? <span className="tag bad" title="实时扫描与上次拉取快照不一致（本地动过）">本地有改动</span> : null}
              </div>
              <Copyable className="ec-path" text={s.path} title={s.path}>{s.path}</Copyable>
              <div className="ec-stats">
                <span><b>{s.count}</b> 个 skill</span>
                <span title={s.remote.fetchedAt}>拉取于 {ago(s.remote.fetchedAt)}</span>
              </div>
              <div
                style={{ display: 'flex', gap: 5, marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--line,#e5e5ee)' }}
                onClick={(e) => e.stopPropagation()}
              >
                <button className="btn small ghost" onClick={() => syncOne(s)} disabled={busyId === s.path || busyAll}>
                  {busyId === s.path ? '同步中…' : '同步'}
                </button>
                <button className="btn small ghost" onClick={() => unsubscribe(s)}>退订…</button>
              </div>
            </div>
          );
        })}
        <div className="entry-card add-tile" onClick={() => subscribe('')}>＋ 订阅远程源</div>
        {!sources.length && data ? <div className="muted">（还没有远程订阅源——用下面的搜索找一个，或直接输入规格订阅）</div> : null}
        {!data ? <div className="muted">读取中…</div> : null}
      </div>

      <div className="section-label">发现
        <span className="hint">搜 skills.sh 注册表 · 结果一键订阅</span>
      </div>
      <div className="toolbar">
        <input
          className="search grow" placeholder="关键词（至少 2 个字符）…" value={q} spellCheck="false"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') doSearch(); }}
        />
        <input
          className="search" style={{ maxWidth: 160 }} placeholder="owner（可选）" value={owner} spellCheck="false"
          onChange={(e) => setOwner(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') doSearch(); }}
        />
        <button className="btn" onClick={doSearch} disabled={searching}>{searching ? '搜索中…' : '搜索'}</button>
      </div>
      <div className="list" style={{ marginTop: 8 }}>
        {(results || []).map((r) => (
          <div key={r.slug || r.name} className="row">
            <div className="name">{r.name}</div>
            <div className="desc mono" title={r.source}>{r.source}</div>
            <div className="acts">
              <span className="muted">{r.installs} 次安装</span>
              <button className="btn small" onClick={() => subscribe(r.source)} disabled={subscribing === r.source}>
                {subscribing === r.source ? '订阅中…' : '订阅'}
              </button>
            </div>
          </div>
        ))}
        {results && !results.length ? <div className="muted">（没有匹配的结果）</div> : null}
        {results === null ? <div className="muted">（输入关键词搜 skills.sh，或直接在上方订阅 owner/repo）</div> : null}
      </div>

      <CliHints module="skills" />
      {syncReport ? <Modal title={syncReport.dryRun ? '同步预演' : '同步结果'} onClose={() => setSyncReport(null)}><SyncReportBody report={syncReport} onClose={() => setSyncReport(null)} /></Modal> : null}
      {dlgNode}
    </>
  );
}
