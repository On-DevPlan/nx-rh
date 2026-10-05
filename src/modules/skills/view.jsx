// Skill 模块（三级结构 + 项目子页）：
//   ① 总览 #/skills            订阅源入口 + 当前项目入口 + 全部平台入口 + 快捷设置
//   ② 子页 #/skills/platform/<id> · #/skills/hub/<encoded path> · #/skills/project
//                               该平台 / 订阅源 / 当前项目目录下的 skill 卡片网格
//   ③ 详情 #/skills/skill/<name>  平台安装状态 + 迁移 / 提交 / 删除，文件预览收在最后
//
// 模型不变：订阅源（唯一可信源）→ 平台目录（迁移）；平台 → 订阅源（提交收进）。
// 不在订阅源的 skill 走「收进订阅源（submit）→ 目标改回软链接」的中心化动作集。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { useStore } from '../../web/frontend/store.jsx';
import { useToast, useGuard, useDialog, Modal, Copyable } from '../../web/frontend/components/ui.jsx';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';

const SCOPE_SHORT = { user: '用户', project: '项目' };

function shortLabel(adapterId, adapters) {
  const a = adapters.find((x) => x.id === adapterId);
  return (a ? a.name : adapterId).replace(/\s*\(.*\)$/, '').split(/[\s-]/)[0].toLowerCase();
}

const pathSegs = (p) => String(p || '').replace(/\\/g, '/').split('/').filter(Boolean);
const lastSeg = (p) => pathSegs(p).slice(-1)[0] || String(p || '');

// 订阅源展示名：多源时取「最短能唯一区分」的尾部段。
function sourceLabel(p, all) {
  if (!p) return '';
  const uniq = [...new Set([...(all || []), p].filter(Boolean))];
  if (uniq.length < 2) return lastSeg(p);
  const all2 = uniq.map(pathSegs);
  let common = 0;
  const minLen = Math.min(...all2.map((s) => s.length));
  while (common + 1 < minLen) {
    const i = common + 1;
    const tail = all2[0][all2[0].length - i].toLowerCase();
    if (all2.every((s) => s[s.length - i].toLowerCase() === tail)) common += 1;
    else break;
  }
  const pools = all2.map((s) => (s.length > common ? s.slice(0, s.length - common) : s));
  const idx = uniq.indexOf(p);
  const own = pools[idx];
  let n = 1;
  while (n < own.length) {
    const tail = own.slice(-n).join('/').toLowerCase();
    if (!pools.some((o, j) => j !== idx && o.slice(-n).join('/').toLowerCase() === tail)) break;
    n += 1;
  }
  return own.slice(-n).join('/') || lastSeg(p);
}

// ─── 路由 ────────────────────────────────────────────────────────────

function parseRoute() {
  const h = (location.hash || '').replace(/^#\/?/, '');
  const parts = h.split('/');
  const level = parts[1] || 'overview';
  const arg = parts[2] ? decodeURIComponent(parts[2]) : '';
  return { level, arg };
}

const goOverview = () => { location.hash = '#/skills'; };
const goPlatform = (id) => { location.hash = `#/skills/platform/${id}`; };
const goHub = (path) => { location.hash = `#/skills/hub/${encodeURIComponent(path)}`; };
const goProject = () => { location.hash = '#/skills/project'; };
const goSkill = (name) => { location.hash = `#/skills/skill/${encodeURIComponent(name)}`; };

function Crumbs({ trail }) {
  return (
    <div className="crumbs">
      <a onClick={goOverview}>Skill</a>
      {trail.map((t, i) => (
        <span key={i} style={{ display: 'contents' }}>
          <span className="sep">/</span>
          {i === trail.length - 1 || !t.on
            ? <span className="cur">{t.label}</span>
            : <a onClick={t.on}>{t.label}</a>}
        </span>
      ))}
    </div>
  );
}

// ─── 数据 hook ───────────────────────────────────────────────────────

function useSkillsData({ platform, source }, tick) {
  const { ui } = useStore();
  const project = ui.activeScope?.path || '';
  const load = useCallback(async () => {
    const qs = new URLSearchParams();
    if (project) qs.set('project', project);
    if (platform) qs.set('platform', platform);
    if (source) qs.set('source', source);
    return await api('/api/skills?' + qs.toString()).catch(() => null);
  }, [project, platform, source]);

  const [data, setData] = useState(null);
  useEffect(() => { let alive = true; load().then((d) => { if (alive) setData(d); }); return () => { alive = false; }; }, [load, tick]);
  return { data, reload: load, setData };
}

// ─── skill 编辑器（新建 / 编辑，弹窗） ───────────────────────────────

function SkillEditor({ mode, skill = {}, close, reload }) {
  const { toast } = useToast();
  const isEdit = mode === 'edit';
  const [name, setName] = useState(skill.name || '');
  const [description, setDescription] = useState(skill.description || '');
  const [content, setContent] = useState(skill.content || '');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (busy) return;
    setErr('');
    if (!isEdit && !name.trim()) { setErr('需要一个 skill 名（小写连字符）'); return; }
    setBusy(true);
    try {
      if (isEdit) {
        await api('/api/skills/' + encodeURIComponent(skill.name), { method: 'PATCH', body: { content } });
      } else {
        await api('/api/skills', { method: 'POST', body: { name: name.trim(), description, content } });
      }
      toast(isEdit ? '已保存' : '已创建');
      close();
      await reload();
    } catch (e) {
      setErr(String((e && e.message) || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {err ? <div className="tag bad" style={{ marginBottom: 8, whiteSpace: 'pre-wrap' }}>{err}</div> : null}
      {!isEdit ? (
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <input style={{ flex: 1 }} placeholder="skill 名（小写连字符，如 my-skill）" value={name} spellCheck="false" onChange={(e) => setName(e.target.value)} />
          <input style={{ flex: 2 }} placeholder="一句话描述（写入 frontmatter）" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
      ) : null}
      <textarea
        style={{
          width: '100%', minHeight: 320, padding: 8,
          fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12, lineHeight: 1.5,
          border: '1px solid var(--soft-2)', borderRadius: 4, background: 'var(--paper)', color: 'var(--ink)',
        }}
        spellCheck="false"
        placeholder={
          isEdit ? ''
            : '正文（留空则自动生成 frontmatter 与标题）。\n也可以直接给完整 SKILL.md（以 --- 开头，name 须与上面一致）。'
        }
        value={content}
        onChange={(e) => setContent(e.target.value)}
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
        <button className="btn ghost" onClick={close}>取消</button>
        <button className="btn" disabled={busy} onClick={save}>{busy ? '保存中…' : '保存'}</button>
      </div>
    </>
  );
}

// skill 文件查看器：左树右内容，SKILL.md 默认选中。
function SkillFiles({ name }) {
  const [files, setFiles] = useState(null);
  const [cur, setCur] = useState('');
  const [text, setText] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    api('/api/skills/detail?name=' + encodeURIComponent(name))
      .then((d) => {
        if (!alive) return;
        const fl = d.files || [];
        setFiles(fl);
        setCur(fl.find((f) => f.path.toLowerCase() === 'skill.md')?.path || fl[0]?.path || '');
      })
      .catch((e) => alive && setErr(String((e && e.message) || e)));
    return () => { alive = false; };
  }, [name]);

  useEffect(() => {
    if (!cur) return undefined;
    let alive = true;
    setText(null);
    setErr('');
    api(`/api/skills/content?name=${encodeURIComponent(name)}&ref=${encodeURIComponent(cur)}`)
      .then((d) => { if (alive) setText(d.content); })
      .catch((e) => { if (alive) setErr(String((e && e.message) || e)); });
    return () => { alive = false; };
  }, [name, cur]);

  if (err) return <div className="dlg-msg">读取失败：{err}</div>;
  if (!files) return <div className="muted">读取中…</div>;
  if (!files.length) return <div className="muted">（这个 skill 目录里没有文件）</div>;
  return (
    <div className="skl-files">
      <div className="skl-tree">
        {files.map((f) => (
          <button key={f.path} type="button" className={'skl-file' + (f.path === cur ? ' on' : '')} title={f.path} onClick={() => setCur(f.path)}>
            <span className="p">{f.path}</span>
            <span className="b">{f.bytes < 1024 ? `${f.bytes} B` : `${Math.round(f.bytes / 1024)} KB`}</span>
          </button>
        ))}
      </div>
      <div className="skl-body">
        {text === null ? <div className="muted">读取中…</div> : <pre>{text}</pre>}
      </div>
    </div>
  );
}

// ─── ① 总览页 ───────────────────────────────────────────────────────

// 快捷设置浮层：迁移形态 / 默认平台 / 平台范围——Skill 域的高频设置就地可改，
// 不必跳去「设置」页（设置页保留完整形态，两边写同一个 POST /api/settings）。
function QuickSettings() {
  const { boot, refreshBoot } = useStore();
  const toast = useToast();
  const guard = useGuard();
  const s = boot?.settings || {};
  const adapters = boot?.adapters || [];
  const scope = new Set(s.platforms || []);

  const patch = (body) => guard(async () => {
    await api('/api/settings', { method: 'POST', body });
    await refreshBoot();
    toast('已保存');
  });

  const togglePlatform = (id) => {
    const next = scope.has(id) ? [...scope].filter((x) => x !== id) : [...scope, id];
    if (!next.length) { toast('平台范围至少保留一个'); return; }
    let def = s.defaultPlatform;
    if (!next.includes(def)) def = next[0];
    patch({ platforms: next, defaultPlatform: def });
  };

  return (
    <details className="tb-set">
      <summary>快捷设置</summary>
      <div className="tb-set-box">
        <div className="row-inline">
          <label>迁移形态</label>
          <select aria-label="迁移形态" value={s.skillSyncMode === 'copy' ? 'copy' : 'symlink'} onChange={(e) => patch({ skillSyncMode: e.target.value })}>
            <option value="symlink">软链接</option>
            <option value="copy">复制</option>
          </select>
        </div>
        <div className="row-inline">
          <label>默认平台</label>
          <select
            aria-label="默认平台"
            value={s.defaultPlatform || 'claude-code'}
            onChange={(e) => patch({ defaultPlatform: e.target.value, platforms: [e.target.value, ...[...scope].filter((x) => x !== e.target.value)] })}
          >
            {[...(scope.size ? scope : ['claude-code'])].map((id) => (
              <option key={id} value={id}>{(adapters.find((a) => a.id === id) || {}).name || id}</option>
            ))}
          </select>
        </div>
        <div className="row-inline">
          <label>平台范围</label>
          <span className="plats">
            {adapters.map((a) => (
              <button key={a.id} type="button" className={'pill' + (scope.has(a.id) ? ' on' : '')} onClick={() => togglePlatform(a.id)}>
                {shortLabel(a.id, adapters)}
              </button>
            ))}
          </span>
        </div>
      </div>
    </details>
  );
}

function Overview({ data, openCreate }) {
  const guard = useGuard();
  const { dialog, node: dialogNode } = useDialog();
  const sources = data?.sources || [];
  const srcPaths = sources.map((s) => s.path);
  const summary = data?.platformSummary || [];

  const subscribe = () => guard(async () => {
    const p = await dialog({ title: '订阅一个 skill 目录（目录下直接是各 skill）', input: true });
    if (!p) return;
    await api('/api/skills/sources', { method: 'POST', body: { path: p } });
    goOverview();
  });

  return (
    <>
      <div className="page-head">
        <div className="title-block">
          <h2>Skill</h2>
          <div className="page-desc">
            订阅源是唯一可信源。从平台入口查看散落在各 Agent 目录里的 skill，把不在订阅源的收敛回来；也可以从订阅源把 skill 迁移到各平台。
          </div>
        </div>
        <div className="acts">
          <QuickSettings />
          {data?.hub?.path ? <button className="btn" onClick={openCreate}>＋ 新建</button> : null}
        </div>
      </div>

      <div className="section-label">订阅源
        <span className="hint">{sources.length} 个 · 点进去看 / 迁移该源的 skill</span>
      </div>
      <div className="entry-grid">
        {sources.map((s) => (
          <div key={s.path} className="entry-card" onClick={() => goHub(s.path)}>
            <div className="ec-top">
              <span className="ec-name">{sourceLabel(s.path, srcPaths)}</span>
              {s.current ? <span className="tag strong">主源</span> : null}
              {!s.exists ? <span className="tag bad">不存在</span> : null}
            </div>
            <div className="ec-path" title={s.path}>{s.path}</div>
            <div className="ec-stats"><span><b>{s.count}</b> 个 skill</span></div>
          </div>
        ))}
        <div className="entry-card add-tile" onClick={subscribe}>＋ 订阅新目录</div>
      </div>

      <div className="section-label">当前项目
        <span className="hint">项目目录里实际存在的 skill（cwd 作用域）</span>
      </div>
      <div className="entry-grid">
        {(() => {
          const ps = data?.projectSummary;
          if (!ps?.count) {
            return (
              <div className="entry-card off" onClick={goProject}>
                <div className="ec-top"><span className="ec-name">{lastSeg(ps?.root || '') || '当前项目'}</span></div>
                <div className="ec-path" title={ps?.root || ''}>{ps?.root || '（读取中…）'}</div>
                <div className="ec-stats"><span>项目目录里还没有 skill</span></div>
              </div>
            );
          }
          return (
            <div className="entry-card" onClick={goProject}>
              <div className="ec-top"><span className="ec-name">{lastSeg(ps.root)}</span></div>
              <div className="ec-path mono" title={ps.root}>{ps.root}</div>
              <div className="ec-stats">
                <span><b>{ps.count}</b> 个 skill</span>
                {ps.orphan ? <span style={{ color: 'var(--ink)' }}><b>{ps.orphan}</b> 不在订阅源</span> : null}
              </div>
            </div>
          );
        })()}
      </div>

      <div className="section-label">平台
        <span className="hint">{summary.length} 个 Agent 平台 · 点进去快速收敛 / 查看</span>
      </div>
      <div className="entry-grid">
        {summary.map((p) => {
          const total = p.managed + p.orphan;
          return (
            <div key={p.id} className={'entry-card' + (p.enabled ? '' : ' off')} onClick={() => goPlatform(p.id)}>
              <div className="ec-top">
                <span className="ec-name">{p.name}</span>
                {p.isDefault ? <span className="tag strong">默认</span>
                  : p.enabled ? <span className="tag">已启用</span>
                    : <span className="tag">未启用</span>}
              </div>
              <div className="ec-path mono">{p.id}</div>
              <div className="ec-stats">
                <span><b>{total}</b> 处安装</span>
                {p.orphan ? <span style={{ color: 'var(--ink)' }}><b>{p.orphan}</b> 不在订阅源</span> : null}
              </div>
            </div>
          );
        })}
      </div>

      <CliHints module="skills" />
      {dialogNode}
    </>
  );
}

// ─── skill 卡片（网格单元） ─────────────────────────────────────────

function SkillCard({ name, description, checked, onToggle, children, onClick }) {
  return (
    <div className="skl-card" onClick={onClick}>
      <div className="sc-top">
        <input
          type="checkbox" checked={checked}
          title="勾选用于批量操作"
          onClick={(e) => e.stopPropagation()}
          onChange={onToggle}
        />
        <span className="sc-name" title={name}>{name}</span>
      </div>
      <div className="sc-desc" title={description || ''}>{description}</div>
      <div className="sc-foot" onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>
  );
}

// ─── 收进订阅源：选源弹窗（submit 的目标源可挑，缺省主源） ─────────────

function SubmitIntoDialog({ names, onClose, onDone }) {
  const { boot, refreshBoot } = useStore();
  const toast = useToast();
  const guard = useGuard();
  const { dialog, node: dlgNode } = useDialog();
  const sources = boot?.sources || [];
  const [into, setInto] = useState('');
  const [busy, setBusy] = useState(false);

  // 缺省选中主源；sources 晚一拍到达时补上
  useEffect(() => {
    if (!into && sources.length) setInto((sources.find((s) => s.current) || sources[0]).path);
  }, [into, sources]);

  const srcPaths = sources.map((s) => s.path);
  const srcLabel = (p) => sourceLabel(p, srcPaths);

  const ok = () => guard(async () => {
    if (!into) { toast('请选择订阅源'); return; }
    setBusy(true);
    try {
      let r = await api('/api/skills/submit', { method: 'POST', body: { name: names, to: 'all', platform: 'all', into } });
      if (r.status === 'conflict') {
        const go = await dialog({ message: `订阅源里已有同名且内容不同（${r.conflicts.length} 个 skill）。用这份覆盖？`, danger: true });
        if (!go) return;
        r = await api('/api/skills/submit', { method: 'POST', body: { name: names, to: 'all', platform: 'all', into, force: true } });
      }
      toast(`已收进 ${srcLabel(into)}（${r.submitted} 个，跳过 ${r.skipped}）`);
      await refreshBoot();
      onDone();
    } finally {
      setBusy(false);
    }
  });

  return (
    <Modal title={`收进订阅源（${names.length} 个 skill）`} onClose={onClose}>
      <div className="vlegend">收进后删除平台目录里的实文件，并改回指向订阅源的软链接。</div>
      <div className="list">
        {sources.length ? sources.map((s) => (
          <label key={s.path} className="row src-row">
            <input type="radio" name="submit-into" checked={into === s.path} onChange={() => setInto(s.path)} />
            <span className="name">{srcLabel(s.path)}{s.current ? '（主源）' : ''}</span>
            <span className="desc mono" title={s.path}>{s.path}</span>
            {!s.exists ? <span className="tag bad">不存在</span> : null}
          </label>
        )) : <div className="row muted">（还没有订阅源，先在总览页订阅一个目录）</div>}
      </div>
      <div className="dlg-acts">
        <button className="btn ghost" onClick={onClose}>取消</button>
        <button className="btn" disabled={busy || !sources.length} onClick={ok}>{busy ? '提交中…' : '收进'}</button>
      </div>
      {dlgNode}
    </Modal>
  );
}

// ─── ② 平台子页 ─────────────────────────────────────────────────────

function PlatformPage({ platformId, tick }) {
  const { data, reload } = useSkillsData({ platform: platformId }, tick);
  const { boot, ui, patchUi, toggleSel, refreshBoot } = useStore();
  const toast = useToast();
  const guard = useGuard();
  const { node: dialogNode } = useDialog();
  const [q, setQ] = useState('');
  const [submitNames, setSubmitNames] = useState(null);

  const adapters = boot?.adapters || [];
  const settings = boot?.settings || {};
  const enabled = (settings.platforms || []).includes(platformId);
  const sel = useMemo(() => new Set(ui.selSkills), [ui.selSkills]);

  const hit = (n, d) => !q || `${n} ${d || ''}`.toLowerCase().includes(q.toLowerCase());

  // 该平台里「在订阅源」且实际存在的 skill
  const managed = (data?.skills || []).filter((s) => s.cells.some((c) => c.on));
  const orphans = data?.orphans || [];

  const toggleEnabled = () => guard(async () => {
    const scope = new Set(settings.platforms || []);
    let next;
    let def = settings.defaultPlatform;
    if (enabled) {
      next = [...scope].filter((x) => x !== platformId);
      if (!next.length) { toast('平台范围至少保留一个'); return; }
      if (def === platformId) def = next[0];
    } else {
      next = [...scope, platformId];
      if (!def) def = platformId;
    }
    await api('/api/settings', { method: 'POST', body: { platforms: next, defaultPlatform: def } });
    await refreshBoot();
  });

  const platName = (adapters.find((a) => a.id === platformId) || {}).name || platformId;

  return (
    <>
      <Crumbs trail={[{ label: platName }]} />
      <div className="sub-head">
        <div>
          <div style={{ fontSize: 15, fontWeight: 700 }}>{platName}</div>
          <div className="sub-meta">{managed.length} 个已在订阅源 · {orphans.length} 个不在订阅源</div>
        </div>
        <div className="acts">
          {orphans.some((o) => sel.has(o.name)) ? <button className="btn" onClick={() => setSubmitNames(orphans.map((o) => o.name).filter((n) => sel.has(n)))}>收进订阅源…</button> : null}
          <button className="btn ghost" onClick={toggleEnabled}>{enabled ? '移出启用范围' : '加入启用范围'}</button>
        </div>
      </div>

      <div className="toolbar">
        <input className="search grow" placeholder="过滤名称 / 描述…" value={q} spellCheck="false" onChange={(e) => setQ(e.target.value)} />
      </div>

      {orphans.length ? (
        <>
          <div className="section-label">不在订阅源
            <span className="hint">这些只在平台目录里；勾选后可收进订阅源</span>
          </div>
          <div className="skl-grid">
            {orphans.filter((o) => hit(o.name, o.description)).map((o) => (
              <SkillCard
                key={o.name} name={o.name} description={o.description}
                checked={sel.has(o.name)} onToggle={() => toggleSel('selSkills', o.name)}
                onClick={() => goSkill(o.name)}
              >
                <span className="tag bad">不在订阅源</span>
                <span className="spacer"></span>
                <span className="sc-mini" onClick={() => goSkill(o.name)}>详情</span>
              </SkillCard>
            ))}
          </div>
        </>
      ) : null}

      <div className="section-label">已在订阅源
        <span className="hint">链接随订阅源实时变；实体副本是独立一份</span>
      </div>
      <div className="skl-grid">
        {managed.filter((s) => hit(s.name, s.description)).map((s) => (
          <SkillCard
            key={s.name} name={s.name} description={s.description}
            checked={sel.has(s.name)} onToggle={() => toggleSel('selSkills', s.name)}
            onClick={() => goSkill(s.name)}
          >
            {s.cells.filter((c) => c.on).map((c) => (
              <span key={c.scope} className={'sc-mini'} title={c.dir}>
                {SCOPE_SHORT[c.scope]}·{c.linkType ? '链接' : '副本'}
              </span>
            ))}
            <span className="spacer"></span>
            <span className="sc-mini" onClick={() => goSkill(s.name)}>详情</span>
          </SkillCard>
        ))}
        {!managed.length ? <div className="muted">（这个平台里还没有已收进订阅源的 skill）</div> : null}
      </div>

      {submitNames ? (
        <SubmitIntoDialog
          names={submitNames}
          onClose={() => setSubmitNames(null)}
          onDone={async () => { setSubmitNames(null); patchUi({ selSkills: [] }); await reload(); }}
        />
      ) : null}
      {dialogNode}
    </>
  );
}

// ─── ② 订阅源子页 ───────────────────────────────────────────────────

function HubPage({ hubPath, tick }) {
  const { data, reload } = useSkillsData({ source: hubPath }, tick);
  const { boot, ui, patchUi, toggleSel, refreshBoot } = useStore();
  const toast = useToast();
  const guard = useGuard();
  const { dialog, node: dialogNode } = useDialog();
  const [q, setQ] = useState('');

  const settings = boot?.settings || {};
  const sel = useMemo(() => new Set(ui.selSkills), [ui.selSkills]);
  const skills = data?.skills || [];
  const srcPaths = (data?.sources || []).map((s) => s.path);
  const isCurrent = (data?.sources || []).find((s) => s.current)?.path === hubPath;


  const hit = (n, d) => !q || `${n} ${d || ''}`.toLowerCase().includes(q.toLowerCase());

  const makeMain = () => guard(async () => {
    await api('/api/skills/sources', { method: 'POST', body: { path: hubPath } });
    await refreshBoot();
    toast('已设为主源');
  });

  const bulkMigrate = (to) => guard(async () => {
    const names = skills.map((s) => s.name).filter((n) => sel.has(n));
    if (!names.length) { toast('勾选要迁移的 skill'); return; }
    const ok = await dialog({ message: `将勾选的 ${names.length} 个 skill 迁移到${SCOPE_SHORT[to]}？\n形态: ${settings.skillSyncMode === 'copy' ? '复制' : '软链接'}` });
    if (!ok) return;
    const r = await api('/api/skills/migrate', {
      method: 'POST',
      body: { name: names, to, platform: 'all', mode: settings.skillSyncMode },
    });
    if (r.status === 'blocked') toast(`${r.blocked.length} 处被阻止（跨源冲突，先解决订阅）`);
    else toast(`已迁移 ${r.migrated} 处（跳过 ${r.skipped}）`);
    patchUi({ selSkills: [] });
    await reload();
  });

  return (
    <>
      <Crumbs trail={[{ label: sourceLabel(hubPath, srcPaths) }]} />
      <div className="sub-head">
        <div>
          <div style={{ fontSize: 15, fontWeight: 700 }}>{sourceLabel(hubPath, srcPaths)}</div>
          <div className="sub-meta mono" title={hubPath}>{hubPath}</div>
        </div>
        <div className="acts">
          {!isCurrent ? <button className="btn ghost" onClick={makeMain}>设为主源</button> : <span className="tag strong">主源</span>}
          {[...sel].length ? <>
            <button className="btn" onClick={() => bulkMigrate('project')}>迁移勾选 → 项目</button>
            <button className="btn" onClick={() => bulkMigrate('user')}>迁移勾选 → 用户</button>
          </> : null}
        </div>
      </div>

      <div className="toolbar">
        <input className="search grow" placeholder="过滤名称 / 描述…" value={q} spellCheck="false" onChange={(e) => setQ(e.target.value)} />
      </div>

      <div className="skl-grid">
        {skills.filter((s) => hit(s.name, s.description)).map((s) => {
          const on = s.cells.filter((c) => c.on).length;
          return (
            <SkillCard
              key={s.name} name={s.name} description={s.description}
              checked={sel.has(s.name)} onToggle={() => toggleSel('selSkills', s.name)}
              onClick={() => goSkill(s.name)}
            >
              <span className={'tag' + (on === s.cells.length && s.cells.length ? ' strong' : '')}>
                {s.cells.length ? `已安装 ${on}/${s.cells.length}` : '未安装'}
              </span>
              <span className="spacer"></span>
              <span className="sc-mini" onClick={() => goSkill(s.name)}>详情</span>
            </SkillCard>
          );
        })}
        {!skills.length ? <div className="muted">（这个订阅源里暂无 skill）</div> : null}
      </div>

      {dialogNode}
    </>
  );
}

// ─── ② 当前项目子页：cwd 作用域下各平台项目目录里实际存在的 skill ─────

function useProjectSkills(tick) {
  const { ui } = useStore();
  const project = ui.activeScope?.path || '';
  const load = useCallback(async () => {
    const qs = new URLSearchParams();
    if (project) qs.set('project', project);
    return await api('/api/skills/project-skills?' + qs.toString()).catch(() => null);
  }, [project]);
  const [data, setData] = useState(null);
  useEffect(() => { let alive = true; load().then((d) => { if (alive) setData(d); }); return () => { alive = false; }; }, [load, tick]);
  return { data, reload: load };
}

function ProjectPage({ tick }) {
  const { data, reload } = useProjectSkills(tick);
  const { boot, ui, patchUi, toggleSel } = useStore();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [submitNames, setSubmitNames] = useState(null);

  const adapters = boot?.adapters || [];
  const sel = useMemo(() => new Set(ui.selSkills), [ui.selSkills]);
  const skills = data?.skills || [];

  const hit = (n, d) => !q || `${n} ${d || ''}`.toLowerCase().includes(q.toLowerCase());
  // 勾选里「不在订阅源」的那批才是可收进的
  const checkedOrphans = skills.filter((s) => !s.inHub && sel.has(s.name)).map((s) => s.name);

  return (
    <>
      <Crumbs trail={[{ label: '当前项目' }]} />
      <div className="sub-head">
        <div>
          <div style={{ fontSize: 15, fontWeight: 700 }}>项目里的 skill</div>
          <div className="sub-meta mono" title={data?.projectRoot}>{data?.projectRoot || '读取中…'}</div>
        </div>
        <div className="acts">
          {checkedOrphans.length ? <button className="btn" onClick={() => setSubmitNames(checkedOrphans)}>收进订阅源…</button> : null}
        </div>
      </div>

      <div className="toolbar">
        <input className="search grow" placeholder="过滤名称 / 描述…" value={q} spellCheck="false" onChange={(e) => setQ(e.target.value)} />
      </div>

      {data?.dirs?.length ? (
        <div className="section-label">项目目录
          <span className="hint">{data.dirs.length} 个平台目录 · * 为启用平台</span>
        </div>
      ) : null}
      {data?.dirs?.length ? (
        <div className="card"><div className="list">
          {data.dirs.map((dir) => (
            <div key={dir.platform} className="row">
              <span className="name">{dir.enabled ? '* ' : ''}{shortLabel(dir.platform, adapters)}</span>
              <Copyable className="desc mono" text={dir.dir} title="点击复制目录路径">{dir.dir}</Copyable>
              <span className="tag">{dir.skills.length} 个</span>
              {!dir.enabled ? <span className="tag">未启用</span> : null}
            </div>
          ))}
        </div></div>
      ) : null}

      <div className="section-label">skill
        <span className="hint">勾选「不在订阅源」的项可批量收进</span>
      </div>
      <div className="skl-grid">
        {skills.filter((s) => hit(s.name, s.description)).map((s) => (
          <SkillCard
            key={s.name} name={s.name} description={s.description}
            checked={sel.has(s.name)} onToggle={() => toggleSel('selSkills', s.name)}
            onClick={() => goSkill(s.name)}
          >
            {!s.inHub ? <span className="tag bad">不在订阅源</span> : <span className="tag">已在订阅源</span>}
            {s.cells.map((c) => (
              <span key={c.platform} className="sc-mini" title={c.dir}>
                {shortLabel(c.platform, adapters)}·{c.linkType ? '链接' : '副本'}
              </span>
            ))}
            <span className="spacer"></span>
            <span className="sc-mini" onClick={() => goSkill(s.name)}>详情</span>
          </SkillCard>
        ))}
        {data && !skills.length ? <div className="muted">（项目目录里还没有 skill）</div> : null}
        {!data ? <div className="muted">读取中…</div> : null}
      </div>

      {submitNames ? (
        <SubmitIntoDialog
          names={submitNames}
          onClose={() => setSubmitNames(null)}
          onDone={async () => { setSubmitNames(null); patchUi({ selSkills: [] }); await reload(); toast('已收进'); }}
        />
      ) : null}
    </>
  );
}

// ─── ③ Skill 详情页 ─────────────────────────────────────────────────

function SkillDetail({ name, tick }) {
  const { boot, patchUi, refreshBoot } = useStore();
  const toast = useToast();
  const guard = useGuard();
  const { dialog, node: dialogNode } = useDialog();
  const [d, setD] = useState(null);
  const [submitOpen, setSubmitOpen] = useState(false);
  const adapters = boot?.adapters || [];
  const settings = boot?.settings || {};

  const load = useCallback(async () => {
    setD(await api('/api/skills/detail?name=' + encodeURIComponent(name)).catch(() => null));
  }, [name]);
  useEffect(() => { load(); }, [load, tick]);

  const isOrphan = d && (d.origin === 'link' || d.origin === 'target');

  const toggleCell = (cell) => guard(async () => {
    const base = { name, to: cell.scope, platform: cell.platform };
    if (cell.on) {
      let r = await api('/api/skills/unmigrate', { method: 'POST', body: base });
      if (r.status === 'blocked') {
        const ok = await dialog({ message: `「${name}」在 ${SCOPE_SHORT[cell.scope]}·${cell.platformName} 是实体副本（可能含本地改动）。\n删除不可逆，确认？`, danger: true });
        if (!ok) return;
        r = await api('/api/skills/unmigrate', { method: 'POST', body: { ...base, force: true } });
      }
      toast(r.removed?.length ? `已撤销 ${SCOPE_SHORT[cell.scope]}·${cell.platform}` : '该目标本就没有');
    } else {
      const r = await api('/api/skills/migrate', { method: 'POST', body: { ...base, mode: settings.skillSyncMode } });
      if (r.status === 'blocked') { toast('跨源冲突，先解决订阅'); await load(); return; }
      toast(`已迁移到 ${SCOPE_SHORT[cell.scope]}·${cell.platform}`);
    }
    await load();
  });

  const migrateScope = (to) => guard(async () => {
    const r = await api('/api/skills/migrate', { method: 'POST', body: { name, to, platform: 'all', mode: settings.skillSyncMode } });
    toast(r.status === 'blocked' ? '跨源冲突，先解决订阅' : `已迁移到${SCOPE_SHORT[to]}`);
    await load();
  });

  const openEdit = () => guard(async () => {
    const c = await api('/api/skills/content?name=' + encodeURIComponent(name));
    patchUi({
      editor: {
        mode: 'edit',
        skill: { name, description: d?.description, content: c.content },
      },
    });
  });

  const doRemove = () => guard(async () => {
    const r = await api('/api/skills/' + encodeURIComponent(name), { method: 'DELETE', body: {} });
    if (r.status === 'blocked') {
      const ok = await dialog({ message: `${r.reason}\n仍要删除？（目标侧会悬空）`, danger: true });
      if (!ok) return;
      await api('/api/skills/' + encodeURIComponent(name), { method: 'DELETE', body: { force: true } });
    }
    toast('已从订阅源删除');
    goOverview();
  });

  const doPurge = () => guard(async () => {
    const dry = await api('/api/skills/purge', { method: 'POST', body: { name, 'dry-run': true } });
    const p = dry.plan;
    const lines = [
      ...p.targets.map((c) => `  安装位置  ${SCOPE_SHORT[c.scope]}·${c.platformName}  ${c.path}${c.linkType ? '（链接）' : '（副本）'}`),
      ...p.sources.map((s) => `  订阅源  ${s.source}\n          → ${s.dir}`),
    ];
    const ok = await dialog({ title: `彻底删除 ${name}`, message: `将删除以下 ${lines.length} 处，不可恢复：\n${lines.join('\n')}`, danger: true, okText: '删除' });
    if (!ok) return;
    await api('/api/skills/purge', { method: 'POST', body: { name, force: true } });
    toast('已彻底删除');
    goOverview();
  });

  const copySkillMd = () => guard(async () => {
    const c = await api(`/api/skills/content?name=${encodeURIComponent(name)}`);
    try { await navigator.clipboard.writeText(c.content); toast('已复制 SKILL.md'); }
    catch { toast('复制失败'); }
  });

  if (!d) return (
    <>
      <Crumbs trail={[{ label: name }]} />
      <div className="muted" style={{ padding: 20 }}>读取中…</div>
      {dialogNode}
    </>
  );

  const cells = d.cells || [];

  return (
    <>
      <Crumbs trail={[{ label: name }]} />

      <div className="page-head" style={{ marginBottom: 12 }}>
        <div className="title-block">
          <h2 style={{ fontSize: 17 }}>{name}</h2>
          <div className="page-desc">{d.description}</div>
          <div className="sub-meta" style={{ marginTop: 4 }}>
            {d.source ? <>来源: <Copyable text={d.source}>{d.source}</Copyable>{' · '}</> : null}
            {d.dir ? <>目录: <Copyable text={d.dir}>{d.dir}</Copyable></> : null}
            {d.stats?.lines ? <> · {d.stats.sections ?? 0} 节 · {d.stats.lines} 行 · {(d.files || []).length} 文件</> : null}
          </div>
        </div>
        <div className="acts">
          <button className="btn ghost" onClick={copySkillMd}>复制 SKILL.md</button>
        </div>
      </div>

      {isOrphan ? <span className="tag bad" style={{ marginBottom: 10 }}>{d.origin === 'link' ? '不在订阅源（游离链接）' : '不在订阅源'}</span> : null}
      {d.broken ? <div className="dlg-msg" style={{ marginBottom: 10 }}>这是断链：目标已不存在，读不到内容。建议彻底删除。</div> : null}
      {d.conflict && !d.conflict.same ? <span className="tag bad" style={{ marginBottom: 10 }}>跨源冲突：同名 skill 在多个订阅源且内容不同</span> : null}

      <div className="colhead" style={{ marginTop: 4 }}><h3>{isOrphan ? '出现位置' : '平台安装状态'}</h3>
        <span className="muted">链接随订阅源实时变；实体副本是独立一份</span>
      </div>
      <div className="card detail-cells">
        <div className="list">
          {cells.length ? cells
            .filter((c) => c.on || !isOrphan)
            .map((c) => (
              <div key={c.scope + c.platform} className="row">
                <span className="name">{SCOPE_SHORT[c.scope]}·{shortLabel(c.platform, adapters)}</span>
                <Copyable className="desc mono" text={c.dir} title="点击复制安装位置路径">{c.dir}</Copyable>
                <span className={'tag' + (c.on ? (c.linkType ? '' : ' strong') : ' bad')}>
                  {c.on ? (c.linkType ? '链接' : '实体') : '未安装'}
                </span>
                {!isOrphan ? (
                  <span className="acts">
                    <button className={'btn small' + (c.on ? ' ghost' : '')} onClick={() => toggleCell(c)}>{c.on ? '撤销' : '迁移'}</button>
                  </span>
                ) : null}
              </div>
            )) : <div className="row muted">（还没有安装到任何平台）</div>}
        </div>
      </div>

      <div className="toolbar" style={{ marginTop: 14, flexWrap: 'wrap' }}>
        {isOrphan
          ? !d.broken
            ? <button className="btn" title="收进后删除这里的实文件，并改回指向订阅源的软链接" onClick={() => setSubmitOpen(true)}>收进订阅源…</button>
            : null
          : <>
              <button className="btn" onClick={() => migrateScope('project')}>迁移 → 项目</button>
              <button className="btn" onClick={() => migrateScope('user')}>迁移 → 用户</button>
              <button className="btn ghost" onClick={openEdit}>编辑</button>
              <button className="btn ghost" title="只从订阅源下架，保留各平台安装位置" onClick={doRemove}>从订阅源删除</button>
            </>}
        <button className="btn danger" title="所有安装位置 + 订阅源实文件一并删除" onClick={doPurge}>彻底删除…</button>
      </div>

      {/* 文件预览放最后且默认折叠：页面主体先给安装状态与操作，长正文不把操作区顶下去 */}
      {!d.broken ? (
        <details className="skl-files-wrap">
          <summary>文件与 SKILL.md 预览（{(d.files || []).length} 个文件）</summary>
          <SkillFiles name={name} />
        </details>
      ) : null}

      {submitOpen ? (
        <SubmitIntoDialog
          names={[name]}
          onClose={() => setSubmitOpen(false)}
          onDone={async () => { setSubmitOpen(false); await load(); await refreshBoot(); }}
        />
      ) : null}
      {dialogNode}
    </>
  );
}

// ─── 模块入口：路由分发 + 全局编辑弹窗 ───────────────────────────────

export default function SkillsView() {
  const [route, setRoute] = useState(parseRoute);
  const [tick, setTick] = useState(0);
  const { ui, patchUi } = useStore();

  useEffect(() => {
    const onHash = () => { setRoute(parseRoute()); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // 总览需要一份默认数据
  const overview = useSkillsData({}, tick);

  const bump = () => setTick((t) => t + 1);

  const openCreate = () => patchUi({ editor: { mode: 'create' } });
  const editor = ui.editor;
  const closeEditor = () => patchUi({ editor: null });

  let body;
  if (route.level === 'platform') {
    body = <PlatformPage platformId={route.arg} tick={tick} />;
  } else if (route.level === 'hub') {
    body = <HubPage hubPath={route.arg} tick={tick} />;
  } else if (route.level === 'project') {
    body = <ProjectPage tick={tick} />;
  } else if (route.level === 'skill') {
    body = <SkillDetail name={route.arg} tick={tick} />;
  } else {
    body = <Overview data={overview.data} openCreate={openCreate} />;
  }

  return (
    <>
      {body}
      {editor ? (
        <Modal title={editor.mode === 'edit' ? `编辑 skill · ${editor.skill?.name}` : '新建 skill'} onClose={closeEditor}>
          <SkillEditor
            mode={editor.mode}
            skill={editor.skill || {}}
            close={closeEditor}
            reload={async () => { bump(); }}
          />
        </Modal>
      ) : null}
    </>
  );
}
