// ② 级子页：远程订阅（#/skills/remote）——唯一一个装着外部 skill 的容器。
//
// 页面三块，与其他子页同款组件：
//   ① 远程订阅内容：实体 / 软链 / 手写定义，带版本指纹与更新时间；逐个更新、移除、加软链
//   ② 发现：搜 skills.sh，结果逐条「导入」——导入前先预览（确认是否导入）
//   ③ 添加定义：手写一个 skill 放进远程订阅
//
// 数据全部走既有 action（svc/remote-hub.js）：每个 Web 操作都有 CLI 等价。
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../web/frontend/api/client.js';
import { useStore } from '../../../web/frontend/store.jsx';
import { useToast, useGuard, useDialog, Modal } from '../../../web/frontend/components/ui.jsx';
import { CliHints } from '../../../web/frontend/components/CliHints.jsx';
import { Crumbs, SkillCard, useSel, makeHit } from './shared.jsx';
import { goHub, goOverview, goSkill } from './routes.js';

const ago = (iso) => {
  if (!iso) return '—';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
};

// 远程订阅内容的行：与本地源同投影（SkillCard），显示形态 / 上游 / 版本 / 安装状态。
function RepoRow({ s, checked, busy, onToggle, onUpdate, onRemove, onLink }) {
  const kind = s.linkType ? '软链' : s.manual ? '手写定义' : '导入';
  const on = (s.cells || []).filter((c) => c.on).length;
  return (
    <SkillCard
      name={s.name} description={s.description || ''}
      checked={checked} onToggle={onToggle}
      onClick={() => goSkill(s.name)}
    >
      <span className="tag">{kind}</span>
      {!s.manual && s.spec ? <span className="tag" title={s.spec}>{`↑${s.spec.split('/').slice(-1)[0]}@${String(s.hash).slice(0, 6)}`}</span> : null}
      <span className={'tag' + (s.cells?.length && on === s.cells.length ? ' strong' : '')}>
        {s.cells?.length ? `已安装 ${on}/${s.cells.length}` : '未安装'}
      </span>
      <span className="muted" title={s.updatedAt}>{ago(s.updatedAt)}</span>
      <span className="spacer"></span>
      {s.manual ? null : (
        <span className="sc-mini" onClick={(e) => { e.stopPropagation(); onUpdate(s); }}>{busy ? '更新中…' : '更新'}</span>
      )}
      <span className="sc-mini" onClick={(e) => { e.stopPropagation(); onLink(s); }}>加软链…</span>
      <span className="sc-mini danger" onClick={(e) => { e.stopPropagation(); onRemove(s); }}>移除</span>
    </SkillCard>
  );
}

export function RemotePage({ tick }) {
  const { patchUi, afterWrite, dataEpoch } = useStore();
  const toast = useToast();
  const guard = useGuard();
  const { dialog, node: dlgNode } = useDialog();
  const sel = useSel();
  const [filter, setFilter] = useState('');        // 本列表的名称/描述过滤（与本地源同款）
  const hit = makeHit(filter);
  const [prune, setPrune] = useState(false);       // 全部更新时顺带清理上游已删的僵尸条目

  const [hub, setHub] = useState(null);            // { dir, skills[] }
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');            // 正在更新的 skill 名
  const [q, setQ] = useState('');
  const [owner, setOwner] = useState('');
  const [limit, setLimit] = useState('20');          // 搜索条数（后端默认 20）
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState(null);
  const [importing, setImporting] = useState('');  // 正在导入的 source
  const [preview, setPreview] = useState(null);  // 导入预演：{ source, skills[], picked:Set }

  const load = useCallback(async () => {
    const d = await api('/api/skills/remote').catch(() => null);
    setHub(d);
    if (!d) setErr('读取失败');
  }, []);

  // tick 用于本页强制重查；dataEpoch 是写后全局广播（store「写后失效」）
  useEffect(() => { let alive = true; load().then(() => { if (!alive) return; }); return () => { alive = false; }; }, [load, tick, dataEpoch]);

  // 写后统一收尾：广播失效（本页列表随 dataEpoch 重拉）+ 重拉 bootstrap
  const refresh = async () => { await afterWrite(); };

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
      const res = await api('/api/skills/remote/update', { method: 'POST', body: prune ? { prune: true } : {}, timeoutMs: 300000 });
      const changed = (res.results || []).filter((x) => x.status === 'updated').length;
      const pruned = (res.results || []).filter((x) => x.status === 'removed').length;
      toast(`已检查 ${(res.results || []).length} 个，${changed} 个有更新${pruned ? `，${pruned} 个上游已删${prune ? '并已清理' : '（Hub 里还留着）'}` : ''}`);
      await refresh();
    } finally { setBusy(''); }
  });

  const removeOne = (s) => guard(async () => {
    const ok = await dialog({
      title: '从远程订阅 移除',
      message: `${s.name}\n${s.dir}\n\n只动远程订阅里的这一份；平台目录里的副本请另行 purge。`,
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
      message: `把「${s.name}」链到别处的目录；也可填别处 skill 的目录，远程订阅里会多一个指向它的链接。`,
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

  // ---- 软链出去：在别处建一个指向容器内实体的链接（容器里这份不动）----
  const linkOut = (s) => guard(async () => {
    const target = await dialog({
      title: '软链出去',
      input: true,
      placeholder: '目标位置（要新建的链接，如 D:/lab/skills）',
      message: `在目标位置建一个指向容器内「${s.name}」的链接；容器里这份不动。`,
    });
    if (!target) return;
    const r = await api('/api/skills/remote/link-out', { method: 'POST', body: { name: s.name, target }, timeoutMs: 30000 });
    toast(`已链出: ${s.name} → ${r.to || target}`);
  });

  // ---- 搜索 → 确认 → 导入 ----
  const doSearch = () => guard(async () => {
    if (searching) return;
    if (!q.trim()) { toast('先输入关键词'); return; }
    setSearching(true);
    try {
      const qs = new URLSearchParams({ query: q });
      if (owner.trim()) qs.set('owner', owner.trim());
      if (limit) qs.set('limit', String(limit));
      const r = await api('/api/skills/search?' + qs.toString(), { timeoutMs: 30000 });
      setResults(r.results || []);
    } finally { setSearching(false); }
  });

  // 导入前先「看清楚再确认」：--dry-run 拉预览（列名称/描述/指纹），确认后才真导。
  // 预览做成可选清单——只导勾中的那几个（不全导）。
  const confirmImport = (r) => guard(async () => {
    setImporting(r.source);
    let preview;
    try {
      preview = await api('/api/skills/remote/import', {
        method: 'POST', body: { spec: r.source, 'dry-run': true }, timeoutMs: 300000,
      });
    } finally { setImporting(''); }
    const skills = preview.skills || [];
    setPreview({ source: r.source, skills, picked: new Set(skills.map((s) => s.name)) });
  });

  const togglePick = (name) => setPreview((p) => {
    if (!p) return p;
    const picked = new Set(p.picked);
    picked.has(name) ? picked.delete(name) : picked.add(name);
    return { ...p, picked };
  });

  // 真导：全选时一次整仓导；只选一部分时——**导一次再移除未选**。
  // 为什么不逐个 name 导：importToRemote 每次调用都会重新拉一遍上游，
  // 选 3 个导 3 次 = 克隆 3 次仓库。导 1 次 + 移除未选，终态一致、只拉一次。
  const doImport = () => guard(async () => {
    if (!preview) return;
    const all = preview.skills.map((s) => s.name);
    const picked = all.filter((n) => preview.picked.has(n));
    const skipped = all.filter((n) => !preview.picked.has(n));
    if (!picked.length) { toast('一个都没勾选'); return; }
    setImporting(preview.source);
    try {
      const res = await api('/api/skills/remote/import', { method: 'POST', body: { spec: preview.source }, timeoutMs: 300000 });
      const imported = res.imported || [];
      for (const n of skipped) {
        if (!imported.includes(n)) continue;
        await api('/api/skills/remote/remove', { method: 'POST', body: { name: [n] }, timeoutMs: 30000 });
      }
      const kept = picked.filter((n) => imported.includes(n));
      toast(`已导入 ${kept.length} 个: ${kept.join('、')}${skipped.length ? `（未勾选的 ${skipped.length} 个已移除）` : ''}`);
      setPreview(null);
      await refresh();
    } finally { setImporting(''); }
  });

  const skills = hub?.skills || [];
  const visible = skills.filter((s) => hit(s.name, s.description));

  // 多区段（工作台式）：工具区的过滤组与主按钮随区段联动，位置不动内容换
  const [seg, setSeg] = useState('content'); // 'content' | 'find' | 'adv'
  const segTabs = (
    <div className="seg">
      <button className={'sg' + (seg === 'content' ? ' on' : '')} onClick={() => setSeg('content')}>内容</button>
      <button className={'sg' + (seg === 'find' ? ' on' : '')} onClick={() => setSeg('find')}>发现导入</button>
      <button className={'sg' + (seg === 'adv' ? ' on' : '')} onClick={() => setSeg('adv')}>定义与软链</button>
    </div>
  );

  return (
    <>
      <Crumbs trail={[{ label: '远程订阅' }]} />
      <div className="page-head" style={{ marginBottom: 10 }}>
        <div className="title-block">
          <h2>远程订阅</h2>
          <div className="sub-meta mono" style={{ marginTop: 2 }}>{hub?.dir || '~/.nx-rh/远程订阅/'} · 外部 skill 都在这里，版本可比可更</div>
        </div>
      </div>

      <div className="toolzone">
        <button className="btn small ghost" onClick={goOverview}>← 返回</button>
        <span className="sep"></span>
        {seg === 'content' ? (
          <div className="tz-filter">
            <label className="chk-all">
              <input
                type="checkbox" title="全选（用于批量操作）"
                checked={visible.length > 0 && visible.every((s) => sel.has(s.name))}
                onChange={(e) => patchUi((u) => {
                  const set = new Set(u.selSkills);
                  for (const s of visible) e.target.checked ? set.add(s.name) : set.delete(s.name);
                  return { selSkills: [...set] };
                })}
              />
              全选
            </label>
            <input className="search" placeholder="过滤名称 / 描述…" value={filter} spellCheck="false" onChange={(e) => setFilter(e.target.value)} />
            <label className="chk-all" title="上游已删除的条目，一并从台账里清掉（--prune）">
              <input type="checkbox" checked={prune} onChange={(e) => setPrune(e.target.checked)} />
              清理上游已删
            </label>
          </div>
        ) : seg === 'find' ? (
          <div className="tz-filter">
            <input
              className="search" placeholder="关键词（至少 2 个字符）…" value={q} spellCheck="false"
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') doSearch(); }}
            />
            <input
              placeholder="owner（可选）" value={owner} spellCheck="false"
              onChange={(e) => setOwner(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') doSearch(); }}
            />
            <select
              value={limit} onChange={(e) => setLimit(e.target.value)}
              title="最多返回条数（默认 20）"
            >
              <option value="10">条数 10</option>
              <option value="20">条数 20</option>
              <option value="50">条数 50</option>
            </select>
          </div>
        ) : (
          <div className="tz-filter">
            <span className="muted">手写定义与双向软链 · 链接不复制内容</span>
          </div>
        )}
        <div className="tz-acts">
          {hub?.dir ? (
            <button className="btn ghost" onClick={() => goHub(hub.dir)}>看内容…</button>
          ) : null}
          {seg === 'content' ? (
            <button className="btn" onClick={updateAll} disabled={!!busy || !skills.length}>
              {busy === '*' ? '更新中…' : '全部更新'}
            </button>
          ) : seg === 'find' ? (
            <button className="btn" onClick={doSearch} disabled={searching}>{searching ? '搜索中…' : '搜索'}</button>
          ) : (
            <button className="btn" onClick={addDefinition}>＋ 添加定义</button>
          )}
        </div>
      </div>

      {segTabs}

      {seg === 'content' ? (
        <>
          <div className="section-label">远程订阅内容
            <span className="hint">{skills.length} 个 · 实体/软链都可迁移到平台；导入的才有上游可更新</span>
          </div>
          <div className="skl-grid">
            {visible.map((s) => (
              <RepoRow
                key={s.name} s={s} checked={sel.has(s.name)} busy={busy === s.name}
                onToggle={() => patchUi((u) => {
                  const set = new Set(u.selSkills);
                  set.has(s.name) ? set.delete(s.name) : set.add(s.name);
                  return { selSkills: [...set] };
                })}
                onUpdate={updateOne} onRemove={removeOne} onLink={linkOne}
              />
            ))}
            {hub && !skills.length ? <div className="muted">（远程订阅还是空的——切到「发现导入」区段搜索，或用「＋ 添加定义」）</div> : null}
            {hub && skills.length && !visible.length ? <div className="muted">（没有匹配过滤条件的 skill）</div> : null}
            {!hub && !err ? <div className="muted">读取中…</div> : null}
            {err ? <div className="dlg-msg">{err}</div> : null}
          </div>
        </>
      ) : null}

      {seg === 'find' ? (
        <>
          <div className="section-label">发现
            <span className="hint">搜 skills.sh · 确认后导入到 Hub</span>
          </div>
          <div className="list" style={{ marginTop: 8 }}>
            {(results || []).map((r) => (
              <div key={r.slug || r.name} className="row">
                <div className="name">{r.name}</div>
                <div className="desc mono" title={r.source}>{r.source}</div>
                <div className="acts">
                  <span className="muted">{r.installs} 次安装</span>
                  <button className="btn small ghost" onClick={() => confirmImport(r)} disabled={importing === r.source}>
                    {importing === r.source ? '导入中…' : '导入'}
                  </button>
                </div>
              </div>
            ))}
            {results && !results.length ? <div className="muted">（没有匹配的结果）</div> : null}
            {results === null ? <div className="muted">（在上方工具区输入关键词搜 skills.sh，或用 CLI：nx-rh skill hub remote import owner/repo）</div> : null}
          </div>
        </>
      ) : null}

      {seg === 'adv' ? (
        <>
          <div className="section-label">定义与软链
            <span className="hint">手写条目与双向软链 · 实体留在原地</span>
          </div>
          <div className="card"><div className="list">
            <div className="row">
              <span className="name" style={{ width: 150 }}>添加定义</span>
              <span className="desc">remote add —— 手写一个 SKILL.md 条目放进容器（无上游，不参与 remote update）。入口在本页工具区「＋ 添加定义」</span>
            </div>
            <div className="row">
              <span className="name" style={{ width: 150 }}>加软链</span>
              <span className="desc">remote link —— 在「内容」区每个 skill 的「加软链…」里，把别处的 skill 链进容器</span>
            </div>
          </div></div>

          <div className="card">
            <div className="colhead">
              <h3>软链出去</h3>
              <span className="muted">在别处建一个指向容器内实体的链接 · 容器里这份不动</span>
            </div>
            <div className="list">
              {skills.map((s) => (
                <div key={s.name} className="row">
                  <span className="name" style={{ width: 150 }}>{s.name}</span>
                  <span className="desc mono" title={s.dir}>{s.dir}</span>
                  <span className="acts">
                    <button className="btn small ghost" onClick={() => linkOut(s)}>链出去…</button>
                  </span>
                </div>
              ))}
              {skills.length ? null : <div className="row muted">（容器里还没有 skill）</div>}
            </div>
          </div>
        </>
      ) : null}

      <CliHints module="skills" only={['skill.hub.remote.', 'skill.hub.search', 'skill.hub.refresh']} />

      {preview ? (
        <Modal title={`导入到远程订阅 · ${preview.source}`} onClose={() => setPreview(null)}>
          <div className="vlegend" style={{ padding: '0 0 8px' }}>
            上游共 {preview.skills.length} 个 skill，勾选要导入的（默认全选）。没勾的不会留在容器里。
          </div>
          <div className="list" style={{ border: '1px solid var(--soft-2)', borderRadius: 6, maxHeight: 320, overflow: 'auto' }}>
            {preview.skills.map((s) => (
              <label key={s.name} className="row src-row">
                <input type="checkbox" checked={preview.picked.has(s.name)} onChange={() => togglePick(s.name)} />
                <span className="name" style={{ width: 190 }}>{s.name}</span>
                <span className="desc" title={s.description || ''}>{(s.description || '').slice(0, 60) || '（无描述）'}</span>
                <span className="tag mono" title="上游目录指纹">↑{String(s.hash || '').slice(0, 6)}</span>
              </label>
            ))}
          </div>
          <div className="dlg-acts">
            <button className="btn ghost" onClick={() => setPreview(null)}>取消</button>
            <button className="btn" disabled={!!importing || !preview.picked.size} onClick={doImport}>
              {importing ? '导入中…' : `导入勾选的 ${preview.picked.size} 个`}
            </button>
          </div>
        </Modal>
      ) : null}
      {dlgNode}
    </>
  );
}
