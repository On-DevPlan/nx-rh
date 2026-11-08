// ② 远程管理页（#/skills/remote）——外部 skill 的唯一管理面。
//
// 两个区段：
//   ① 内容：已导入远程订阅的 skill，带**版本徽标**（最新 / 待更新 / 上游已删），
//      勾选可批量更新 / 移除
//   ② 发现导入：搜 skills.sh → 预演清单 → 导入并装到平台目录
//
// 版本徽标读的是**上次检查的缓存**（remote list 载荷里的 lastCheck）——
// 打开页面不联网；点「检查更新」才去比对上游。这是 plan/07 R2 判定缺失的
// check-only 能力，现在由 svc/version.js 补上了。
//
// 刻意没有「软链」区段：软链在本地订阅源侧已有 submit / dedupe --as link 一套，
// 远程再开一套是重复造概念。远程 hub 就是个普通的本地 skill hub。
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../../web/frontend/api/client.js';
import { useStore } from '../../../web/frontend/store.jsx';
import { useToast, useGuard, useDialog } from '../../../web/frontend/components/ui.jsx';
import { CliHints } from '../../../web/frontend/components/CliHints.jsx';
import { Crumbs, SkillCard, useSel, makeHit } from './shared.jsx';
import { goOverview, goSkill } from './routes.js';
import { RemoteInstallDialog } from './dialogs.jsx';

const ago = (iso) => {
  if (!iso) return '—';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
};

// 版本徽标：状态 → [文案, 样式类]。
// 'latest' 最新 / 'outdated' 待更新 / 'removed' 上游已删 / 'none' 不给徽标
const VERSION_TAG = {
  latest: ['最新', 'tag strong'],
  outdated: ['待更新', 'tag upd'],
  removed: ['上游已删', 'tag bad'],
  none: null,
};

// 远程订阅内容的行：与本地源同投影（SkillCard），显示形态 / 上游 / 版本 / 安装状态。
function RepoRow({ s, version, checked, busy, onToggle, onUpdate, onRemove }) {
  const kind = s.linkType ? '软链' : s.manual ? '手写定义' : '导入';
  const on = (s.cells || []).filter((c) => c.on).length;
  const vt = VERSION_TAG[version];
  return (
    <SkillCard
      name={s.name} description={s.description || ''}
      checked={checked} onToggle={onToggle}
      onClick={() => goSkill(s.name)}
    >
      <span className="tag">{kind}</span>
      {!s.manual && s.spec ? <span className="tag" title={s.spec}>{`↑${s.spec.split('/').slice(-1)[0]}@${String(s.hash).slice(0, 6)}`}</span> : null}
      {vt ? <span className={vt[1]}>{vt[0]}</span> : null}
      <span className={'tag' + (s.cells?.length && on === s.cells.length ? ' strong' : '')}>
        {s.cells?.length ? `已安装 ${on}/${s.cells.length}` : '未安装'}
      </span>
      <span className="muted" title={s.updatedAt}>{ago(s.updatedAt)}</span>
      <span className="spacer"></span>
      {s.manual ? null : (
        <span className="sc-mini" onClick={(e) => { e.stopPropagation(); onUpdate(s); }}>{busy ? '更新中…' : '更新'}</span>
      )}
      <span className="sc-mini danger" onClick={(e) => { e.stopPropagation(); onRemove(s); }}>移除</span>
    </SkillCard>
  );
}

export function RemotePage({ tick, initialSeg }) {
  const { patchUi, afterWrite, dataEpoch } = useStore();
  const toast = useToast();
  const guard = useGuard();
  const { dialog, node: dlgNode } = useDialog();
  const sel = useSel();
  const [filter, setFilter] = useState('');        // 本列表的名称/描述过滤（与本地源同款）
  const hit = makeHit(filter);
  const [prune, setPrune] = useState(false);       // 全部更新时顺带清理上游已删的僵尸条目
  const [checking, setChecking] = useState(false); // 正在检查上游版本

  const [hub, setHub] = useState(null);            // { dir, skills[], lastCheck }
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');            // 正在更新的 skill 名
  const [q, setQ] = useState('');
  const [owner, setOwner] = useState('');
  const [urlSpec, setUrlSpec] = useState('');   // 按地址安装：来源规格
  const [limit, setLimit] = useState('20');          // 搜索条数（后端默认 20）
  // 多区段（工作台式）：工具区的过滤组与主按钮随区段联动，位置不动内容换
  // initialSeg 来自深链（#/skills/remote/byurl）——总览的「按地址安装」入口直达这里
  const SEG_IDS = ['content', 'byurl', 'find'];
  const [seg, setSeg] = useState(SEG_IDS.includes(initialSeg) ? initialSeg : 'content');
  // 深链变了要跟着切区段：initialSeg 只在 useState 初始化时读一次，
  // 组件不重挂载的话（同一路由只换 hash 参数）改深链不会有反应。
  // 空串也要处理——#/skills/remote（不带区段）= 回「内容」区段。
  useEffect(() => {
    setSeg(SEG_IDS.includes(initialSeg) ? initialSeg : 'content');
  }, [initialSeg]);
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

  // 版本状态：按 skill 名映射。
  //   · lastCheck 里点名的 = 待更新
  //   · 查过且没点名的 = 最新
  //   · 还没查过 = 不给徽标（不谎报「最新」——没比对过就不知道）
  //   · 手写定义 / 遗留软链 = 无上游
  const versionOf = (name) => {
    const s = (hub?.skills || []).find((x) => x.name === name);
    if (!s) return 'none';
    if (s.manual || !s.spec) return 'none';
    const last = hub?.lastCheck;
    if (!last?.at) return 'none';
    if ((last.outdated || []).includes(name)) return 'outdated';
    if ((last.removed || []).includes(name)) return 'removed';
    return 'latest';
  };

  // ---- 检查更新：只读，不换盘 ----
  const checkAll = () => guard(async () => {
    if (checking) return;
    setChecking(true);
    try {
      const r = await api('/api/skills/remote/check', { timeoutMs: 300000 });
      await load();
      await afterWrite();
      const n = r.outdated || 0;
      if (n) toast(`检查完成：${n} 个待更新（${r.upToDate || 0} 个最新）`, 'warn');
      else toast(`检查完成：${r.checked || 0} 个都是最新的`);
    } finally {
      setChecking(false);
    }
  });

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

  // 批量更新勾选（后端 update 的 name 数组本就支持）
  const updateSelected = () => guard(async () => {
    const names = (hub?.skills || []).filter((s) => sel.has(s.name)).map((s) => s.name);
    if (!names.length) return;
    setBusy('*');
    try {
      const res = await api('/api/skills/remote/update', { method: 'POST', body: { name: names }, timeoutMs: 300000 });
      const changed = (res.results || []).filter((x) => x.status === 'updated').length;
      toast(`更新勾选的 ${names.length} 个：${changed} 个有更新`);
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

  // 批量移除勾选
  const removeSelected = () => guard(async () => {
    const names = (hub?.skills || []).filter((s) => sel.has(s.name)).map((s) => s.name);
    if (!names.length) return;
    const ok = await dialog({
      title: '从远程订阅 移除',
      message: `移除勾选的 ${names.length} 个：\n${names.join('、')}\n\n只动远程订阅里的这些份；平台目录里的副本请另行 purge。`,
      danger: true,
      okText: '移除',
    });
    if (!ok) return;
    await api('/api/skills/remote/remove', { method: 'POST', body: { name: names } });
    toast(`已移除 ${names.length} 个`);
    patchUi({ selSkills: [] });
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

  // ---- 搜索 → 确认 → 导入并安装 ----
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
  // 两个入口共用这一条路：搜索结果点「导入」→ 传 source；
  // 「按地址安装」直接传用户贴的 spec。
  const confirmImport = (r) => guard(async () => {
    setImporting(r.source);
    let pre;
    try {
      pre = await api('/api/skills/remote/import', {
        method: 'POST', body: { spec: r.source, 'dry-run': true }, timeoutMs: 300000,
      });
    } finally { setImporting(''); }
    const skills = pre.skills || [];
    setPreview({ source: r.source, skills, picked: new Set(skills.map((s) => s.name)) });
  });

  // ---- 按地址安装：直接贴来源规格 ----
  // 规格形态与 CLI 的 `skill hub remote install <spec>` 完全一致：
  // owner/repo · git URL · 归档 URL · owner/repo#分支 · owner/repo/子目录
  const previewBySpec = () => guard(async () => {
    const spec = urlSpec.trim();
    if (!spec) { toast('先填来源地址'); return; }
    await confirmImport({ source: spec });
  });

  const fillSpec = (spec) => {
    setUrlSpec(spec);
    setSeg('byurl');
  };

  const togglePick = (name) => setPreview((p) => {
    if (!p) return p;
    const picked = new Set(p.picked);
    picked.has(name) ? picked.delete(name) : picked.add(name);
    return { ...p, picked };
  });

  const skills = hub?.skills || [];
  const visible = skills.filter((s) => hit(s.name, s.description));
  const checked = skills.filter((s) => sel.has(s.name)).map((s) => s.name);
  const allOn = visible.length > 0 && visible.every((s) => sel.has(s.name));
  const someOn = !allOn && visible.some((s) => sel.has(s.name));
  const allRef = useRef(null);
  useEffect(() => { if (allRef.current) allRef.current.indeterminate = someOn; }, [someOn]);

  // 多区段（工作台式）：工具区的过滤组与主按钮随区段联动，位置不动内容换
  const segTabs = (
    <div className="seg">
      <button className={'sg' + (seg === 'content' ? ' on' : '')} onClick={() => setSeg('content')}>内容</button>
      <button className={'sg' + (seg === 'byurl' ? ' on' : '')} onClick={() => setSeg('byurl')}>按地址安装</button>
      <button className={'sg' + (seg === 'find' ? ' on' : '')} onClick={() => setSeg('find')}>发现导入</button>
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
            <label className="chk-all" title="全选（用于批量操作）">
              <input
                ref={allRef}
                type="checkbox" title="全选（用于批量操作）"
                checked={allOn} disabled={!visible.length}
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
        ) : seg === 'byurl' ? (
          <div className="tz-filter">
            <input
              className="search" placeholder="owner/repo 或 git URL（如 vercel-labs/agent-skills）…"
              value={urlSpec} spellCheck="false"
              onChange={(e) => setUrlSpec(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') previewBySpec(); }}
            />
          </div>
        ) : (
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
        )}
        <div className="tz-acts">
          {/* 工具区只放这两个：「检查更新」（只读，查上游）与「全部更新」（换盘）。
              「在订阅源里看…」是重复的——远程 hub 本身就是一个订阅源，
              总览的订阅源区已经有「远程订阅」卡片；「＋ 定义」是低频动作，
              挪到内容区里，不占页级工具位。 */}
          {seg === 'content' ? (
            <>
              <button className="btn ghost" onClick={checkAll} disabled={checking || !skills.length}>
                {checking ? '检查中…' : '检查更新'}
              </button>
              <button className="btn" onClick={updateAll} disabled={!!busy || !skills.length}>
                {busy === '*' ? '更新中…' : '全部更新'}
              </button>
            </>
          ) : seg === 'byurl' ? (
            <button className="btn" onClick={previewBySpec} disabled={!!importing || !urlSpec.trim()}>
              {importing ? '读取中…' : '查看内容'}
            </button>
          ) : (
            <button className="btn" onClick={doSearch} disabled={searching}>{searching ? '搜索中…' : '搜索'}</button>
          )}
        </div>
      </div>

      {segTabs}

      {seg === 'content' ? (
        <>
          {checked.length ? (
            <div className="toolzone">
              <span className="tag strong" title={checked.join('、')}>已选 {checked.length}</span>
              <button className="btn small ghost" onClick={() => patchUi({ selSkills: [] })}>清空勾选</button>
              <div className="tz-acts">
                <button className="btn small ghost" onClick={updateSelected} disabled={!!busy}>更新勾选</button>
                <button className="btn small danger-quiet" onClick={removeSelected}>移除勾选…</button>
              </div>
            </div>
          ) : null}

          <div className="section-label">远程订阅内容
            <span className="hint">
              {skills.length} 个 · 导入的才有上游可更新
              {hub?.lastCheck?.at ? ` · 上次检查 ${ago(hub.lastCheck.at)}` : ''}
            </span>
            {/* 「＋ 定义」是低频动作（手写一个 SKILL.md），放在内容区的标题行——
                不占页级工具位，也不用为了它单独开一个区段。 */}
            <span style={{ flex: 1 }} />
            <button className="btn small ghost" onClick={addDefinition}>＋ 定义</button>
          </div>
          <div className="skl-grid">
            {visible.map((s) => (
              <RepoRow
                key={s.name} s={s} version={versionOf(s.name)}
                checked={sel.has(s.name)} busy={busy === s.name}
                onToggle={() => patchUi((u) => {
                  const set = new Set(u.selSkills);
                  set.has(s.name) ? set.delete(s.name) : set.add(s.name);
                  return { selSkills: [...set] };
                })}
                onUpdate={updateOne} onRemove={removeOne}
              />
            ))}
            {hub && !skills.length ? <div className="muted">（远程订阅还是空的——切到「发现导入」区段搜索）</div> : null}
            {hub && skills.length && !visible.length ? <div className="muted">（没有匹配过滤条件的 skill）</div> : null}
            {!hub && !err ? <div className="muted">读取中…</div> : null}
            {err ? <div className="dlg-msg">{err}</div> : null}
          </div>
        </>
      ) : null}

      {seg === 'byurl' ? (
        <>
          <div className="section-label">按地址安装
            <span className="hint">贴来源地址 → 看清里面有什么 → 勾选要装的 → 装到平台目录</span>
          </div>
          <div className="card"><div className="list">
            {/* 规格示例：每行右边那段**本身就是可点的示例**（点了填进上方输入框），
                不是按钮——摆成按钮会让这一屏凭空多出 6 个按钮，
                而它们只是「写法参考」。用虚线框 + hover 提示表明可点。 */}
            <div className="row">
              <span className="name" style={{ width: 150 }}>GitHub 仓库</span>
              <span className="desc mono">owner/repo</span>
              <span className="acts">
                <span className="spec-sample" title="点击填入上方输入框" onClick={() => fillSpec('vercel-labs/agent-skills')}>vercel-labs/agent-skills</span>
              </span>
            </div>
            <div className="row">
              <span className="name" style={{ width: 150 }}>指定分支 / 标签</span>
              <span className="desc mono">owner/repo#分支</span>
              <span className="acts">
                <span className="spec-sample" title="点击填入上方输入框" onClick={() => fillSpec('vercel-labs/agent-skills#main')}>…#main</span>
              </span>
            </div>
            <div className="row">
              <span className="name" style={{ width: 150 }}>只取仓库里的子目录</span>
              <span className="desc mono">owner/repo/子目录</span>
              <span className="acts">
                <span className="spec-sample" title="点击填入上方输入框" onClick={() => fillSpec('vercel-labs/agent-skills/skills')}>…/skills</span>
              </span>
            </div>
            <div className="row">
              <span className="name" style={{ width: 150 }}>完整 git URL</span>
              <span className="desc mono">https://github.com/owner/repo.git</span>
              <span className="acts">
                <span className="spec-sample" title="点击填入上方输入框" onClick={() => fillSpec('https://github.com/vercel-labs/agent-skills.git')}>https://…</span>
              </span>
            </div>
            <div className="row">
              <span className="name" style={{ width: 150 }}>SSH 地址</span>
              <span className="desc mono">git@github.com:owner/repo.git</span>
              <span className="acts">
                <span className="spec-sample" title="点击填入上方输入框" onClick={() => fillSpec('git@github.com:vercel-labs/agent-skills.git')}>git@…</span>
              </span>
            </div>
            <div className="row">
              <span className="name" style={{ width: 150 }}>归档 / 单文件</span>
              <span className="desc mono">https://host/path.zip</span>
              <span className="acts">
                <span className="spec-sample" title="点击填入上方输入框" onClick={() => fillSpec('https://example.com/skills.zip')}>https://…</span>
              </span>
            </div>
          </div></div>
          <div className="muted" style={{ marginTop: 10, fontSize: 11 }}>
            填好后点右上「查看内容」——会先拉一份清单（名称 / 描述 / 版本指纹），确认无误再安装。
            私有仓库需要本机已配好 SSH 密钥或 git 凭据。
          </div>
        </>
      ) : null}

      {seg === 'find' ? (
        <>
          <div className="section-label">发现
            <span className="hint">搜 skills.sh · 确认后导入并装到平台目录</span>
          </div>
          <div className="card"><div className="list">
            {(results || []).map((r) => (
              <div key={r.slug || r.name} className="row">
                <div className="name">{r.name}</div>
                <div className="desc mono" title={r.source}>{r.source}</div>
                <div className="acts">
                  <span className="muted">{r.installs} 次安装</span>
                  <button className="btn small ghost" onClick={() => fillSpec(r.source)} title="把这个地址填进「按地址安装」">按地址装</button>
                  <button className="btn small ghost" onClick={() => confirmImport(r)} disabled={importing === r.source}>
                    {importing === r.source ? '导入中…' : '导入'}
                  </button>
                </div>
              </div>
            ))}
            {results && !results.length ? <div className="row muted">（没有匹配的结果）</div> : null}
            {results === null ? <div className="row muted">（在上方工具区输入关键词搜 skills.sh，或用 CLI：nx-rh skill hub remote install owner/repo）</div> : null}
          </div></div>
        </>
      ) : null}

      <CliHints module="skills" only={['skill.hub.remote.', 'skill.hub.search', 'skill.hub.refresh']} />

      {preview ? (
        <RemoteInstallDialog
          source={preview.source}
          skills={preview.skills}
          picked={preview.picked}
          onTogglePick={togglePick}
          onClose={() => setPreview(null)}
          onDone={async (msg) => { setPreview(null); toast(msg); await refresh(); }}
        />
      ) : null}
      {dlgNode}
    </>
  );
}
