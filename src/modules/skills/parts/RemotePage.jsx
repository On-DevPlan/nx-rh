// ② 级子页：远程 Hub（#/skills/remote）——唯一一个装着外部 skill 的容器。
//
// 页面三块，与其他子页同款组件：
//   ① Hub 内容：实体 / 软链 / 手写定义，带版本指纹与更新时间；逐个更新、移除、加软链
//   ② 发现：搜 skills.sh，结果逐条「导入」——导入前先预览（确认是否导入）
//   ③ 添加定义：手写一个 skill 放进 Hub
//
// 数据全部走既有 action（svc/remote-hub.js）：每个 Web 操作都有 CLI 等价。
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../web/frontend/api/client.js';
import { useStore } from '../../../web/frontend/store.jsx';
import { useToast, useGuard, useDialog } from '../../../web/frontend/components/ui.jsx';
import { CliHints } from '../../../web/frontend/components/CliHints.jsx';
import { Crumbs } from './shared.jsx';

const ago = (iso) => {
  if (!iso) return '—';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
};

// Hub 内容的行：名字 + 形态 + 版本 + 来源 + 更新时间 + 操作
function HubRow({ s, busy, onUpdate, onRemove, onLink }) {
  const kind = s.linkType ? '软链' : s.manual ? '手写定义' : '导入';
  return (
    <div className="row">
      <div className="name">
        {s.name}
        <span className="tag" style={{ marginLeft: 6 }}>{kind}</span>
      </div>
      <div className="desc mono" title={s.spec || s.dir}>
        {s.linkType ? s.dir : s.manual ? '（无上游）' : `${s.spec}${s.ref ? '@' + s.ref : ''}`}
        {`  ·  v${String(s.hash).slice(0, 8)}  ·  ${ago(s.updatedAt)}`}
      </div>
      <div className="acts">
        {s.manual ? null : (
          <button className="btn small ghost" disabled={busy} onClick={() => onUpdate(s)}>
            {busy ? '更新中…' : '更新'}
          </button>
        )}
        <button className="btn small ghost" onClick={() => onLink(s)}>加软链…</button>
        <button className="btn small danger" onClick={() => onRemove(s)}>移除</button>
      </div>
    </div>
  );
}

export function RemotePage({ tick }) {
  const { refreshBoot } = useStore();
  const toast = useToast();
  const guard = useGuard();
  const { dialog, node: dlgNode } = useDialog();

  const [hub, setHub] = useState(null);            // { dir, skills[] }
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');            // 正在更新的 skill 名
  const [q, setQ] = useState('');
  const [owner, setOwner] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState(null);
  const [importing, setImporting] = useState('');  // 正在导入的 source

  const load = useCallback(async () => {
    const d = await api('/api/skills/remote').catch(() => null);
    setHub(d);
    if (!d) setErr('读取失败');
  }, []);

  useEffect(() => { let alive = true; load().then(() => { if (!alive) return; }); return () => { alive = false; }; }, [load, tick]);

  const refresh = async () => { await load(); await refreshBoot(); };

  // ---- 更新：按来源重拉，指纹变了才换 ----
  const updateOne = (s) => guard(async () => {
    if (busy) return;
    setBusy(s.name);
    try {
      const res = await api('/api/skills/remote/update', { method: 'POST', body: { name: [s.name] }, timeoutMs: 300000 });
      const one = (res.results || []).find((x) => x.name === s.name);
      if (one?.status === 'updated') toast(`${s.name} 已更新到 ${String(one.hash).slice(0, 8)}`);
      else if (one?.status === 'unchanged') toast(`${s.name} 无变化`);
      else if (one?.status === 'removed') toast(`${s.name} 上游已删除（Hub 里还留着）`, 'warn');
      else if (one?.status === 'error') toast(`${s.name} 更新失败: ${one.error}`, 'error');
      else toast(`${s.name} 未更新`);
      await refresh();
    } finally { setBusy(''); }
  });

  const updateAll = () => guard(async () => {
    if (busy) return;
    setBusy('*');
    try {
      const res = await api('/api/skills/remote/update', { method: 'POST', body: {}, timeoutMs: 300000 });
      const changed = (res.results || []).filter((x) => x.status === 'updated').length;
      toast(`已检查 ${(res.results || []).length} 个，${changed} 个有更新`);
      await refresh();
    } finally { setBusy(''); }
  });

  const removeOne = (s) => guard(async () => {
    const ok = await dialog({
      title: '从远程 Hub 移除',
      message: `${s.name}\n${s.dir}\n\n只动 Hub 里的这一份；平台目录里的副本请另行 purge。`,
      danger: true,
      okText: '移除',
    });
    if (!ok) return;
    await api('/api/skills/remote/remove', { method: 'POST', body: { name: [s.name] } });
    toast(`已移除 ${s.name}`);
    await refresh();
  });

  // ---- 软链：把 Hub 里的 skill 链到别处，或把别处的 skill 链进 Hub ----
  const linkOne = (s) => guard(async () => {
    const target = await dialog({
      title: '加软链',
      input: true,
      placeholder: '目标目录（含 SKILL.md 的目录）',
      message: `把「${s.name}」链到别处的目录；也可填别处 skill 的目录，Hub 里会多一个指向它的链接。`,
    });
    if (!target) return;
    await api('/api/skills/remote/link', { method: 'POST', body: { name: s.name, target }, timeoutMs: 30000 });
    toast(`已加软链: ${s.name}`);
    await refresh();
  });

  // ---- 添加定义：手写一个 skill ----
  const addDefinition = () => guard(async () => {
    const name = await dialog({ title: '添加定义', input: true, placeholder: 'skill 名（目录名）' });
    if (!name) return;
    const description = await dialog({ title: '这个 skill 做什么？', input: true, placeholder: 'description' });
    await api('/api/skills/remote', { method: 'POST', body: { name, description: description || '' } });
    toast(`已添加定义: ${name}`);
    await refresh();
  });

  // ---- 搜索 → 确认 → 导入 ----
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

  // 导入前先确认（"确认是否导入"）：展示将要导入的来源与名字，确认后才拉
  const confirmImport = (r) => guard(async () => {
    const ok = await dialog({
      title: '导入到远程 Hub',
      message: `来源: ${r.source}\nskill: ${r.name}\n\n拉取后进 ~/.nx-rh/remote-hub/，之后可 migrate 到各平台。`,
      okText: '导入',
    });
    if (!ok) return;
    setImporting(r.source);
    try {
      const res = await api('/api/skills/remote/import', { method: 'POST', body: { spec: r.source }, timeoutMs: 300000 });
      toast(`已导入 ${res.count} 个: ${(res.imported || []).join(', ')}`);
      await refresh();
    } finally { setImporting(''); }
  });

  const skills = hub?.skills || [];

  return (
    <>
      <Crumbs trail={[{ label: '远程 Hub' }]} />
      <div className="sub-head">
        <div>
          <div style={{ fontSize: 15, fontWeight: 700 }}>远程 Hub</div>
          <div className="sub-meta mono">{hub?.dir || '~/.nx-rh/remote-hub/'} · 外部 skill 都在这里，版本可比可更</div>
        </div>
        <div className="acts">
          <button className="btn ghost" onClick={updateAll} disabled={!!busy || !skills.length}>
            {busy === '*' ? '更新中…' : '全部更新'}
          </button>
          <button className="btn ghost" onClick={addDefinition}>＋ 添加定义</button>
        </div>
      </div>

      <div className="section-label">Hub 内容
        <span className="hint">{skills.length} 个 · 实体/软链都可迁移到平台；导入的才有上游可更新</span>
      </div>
      <div className="list">
        {skills.map((s) => (
          <HubRow key={s.name} s={s} busy={busy === s.name} onUpdate={updateOne} onRemove={removeOne} onLink={linkOne} />
        ))}
        {hub && !skills.length ? <div className="muted">（Hub 还是空的——用下面的搜索导入，或「＋ 添加定义」）</div> : null}
        {!hub && !err ? <div className="muted">读取中…</div> : null}
        {err ? <div className="dlg-msg">{err}</div> : null}
      </div>

      <div className="section-label">发现
        <span className="hint">搜 skills.sh · 确认后导入到 Hub</span>
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
              <button className="btn small" onClick={() => confirmImport(r)} disabled={importing === r.source}>
                {importing === r.source ? '导入中…' : '导入'}
              </button>
            </div>
          </div>
        ))}
        {results && !results.length ? <div className="muted">（没有匹配的结果）</div> : null}
        {results === null ? <div className="muted">（输入关键词搜 skills.sh，或用 CLI：nx-rh skill hub remote import owner/repo）</div> : null}
      </div>

      <CliHints module="skills" />
      {dlgNode}
    </>
  );
}
