// Skill 页的弹窗：编辑器、「收进订阅源」选源、迁移选平台、Skill 域设置、订阅源检查。
import { useEffect, useState } from 'react';
import { api } from '../../../web/frontend/api/client.js';
import { useStore } from '../../../web/frontend/store.jsx';
import { useToast, useGuard, useDialog, Modal, Copyable } from '../../../web/frontend/components/ui.jsx';
import { sourceLabel } from '../shared.js';

// skill 编辑器（新建 / 编辑，弹窗）
export function SkillEditor({ mode, skill = {}, close, reload }) {
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

// 收进订阅源：选源弹窗（submit 的目标源可挑，缺省主源）
export function SubmitIntoDialog({ names, onClose, onDone }) {
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

// 迁移到某作用域：显式选平台（复选，缺省勾默认平台）+ 形态（跟随设置/软链接/实体复制）。
// names 是数组：详情页单个 skill 传 [name]，订阅源子页批量传勾选的多个——同一弹窗同一套选择。
// 刻意不提供「全部平台一键铺」——那是误伤面最大的操作；细粒度在安装矩阵逐行做。
export function MigrateToDialog({ names, to, boot, onClose, onDone }) {
  const single = names.length === 1;
  const toast = useToast();
  const guard = useGuard();
  const settings = boot?.settings || {};
  const adapters = boot?.adapters || [];
  const enabledIds = settings.platforms?.length ? settings.platforms : ['claude-code'];
  const [ids, setIds] = useState(() => new Set([settings.defaultPlatform || enabledIds[0]]));
  const [mode, setMode] = useState('auto');
  const [busy, setBusy] = useState(false);

  const platName = (id) => (adapters.find((a) => a.id === id) || {}).name || id;
  const toggle = (id) => setIds((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const ok = () => guard(async () => {
    if (!ids.size) { toast('至少勾选一个平台'); return; }
    setBusy(true);
    try {
      const effMode = mode === 'auto' ? undefined : mode;
      const done = [];
      for (const pid of enabledIds.filter((id) => ids.has(id))) {
        const r = await api('/api/skills/migrate', { method: 'POST', body: { name: names, to, platform: pid, ...(effMode ? { mode: effMode } : {}) } });
        if (single) {
          if (r.status === 'blocked') { toast(`${platName(pid)}：跨源冲突，先解决订阅`); continue; }
          done.push(platName(pid));
        } else {
          // 批量：blocked 只挡同名冲突的那几个，其余照迁——两边都报，不让冲突淹没成功数
          if (r.blocked?.length) toast(`${platName(pid)}：${r.blocked.length} 个跨源冲突，先解决订阅`);
          if (r.migrated || r.skipped) done.push(`${platName(pid)}（${r.migrated} 处${r.skipped ? `，跳过 ${r.skipped}` : ''}）`);
        }
      }
      if (done.length) toast(`已迁移到${to === 'user' ? '用户' : '项目'}级：${done.join('、')}`);
      onDone();
    } finally {
      setBusy(false);
    }
  });

  const how = mode === 'copy' ? '实体复制' : mode === 'symlink' ? '软链接' : `跟随设置（${settings.skillSyncMode === 'copy' ? '复制' : '软链接'}）`;
  return (
    <Modal title={`迁移到${to === 'user' ? '用户' : '项目'}级 · ${single ? names[0] : `${names.length} 个 skill`}`} onClose={onClose}>
      <div className="vlegend">勾选目标平台（可多选）；形态: {how}。</div>
      {!single ? (
        <div className="muted" style={{ fontSize: 12, maxHeight: 84, overflow: 'auto', marginBottom: 8 }} title={names.join('、')}>{names.join('、')}</div>
      ) : null}
      <div className="list">
        {enabledIds.map((id) => (
          <label key={id} className="row src-row">
            <input type="checkbox" checked={ids.has(id)} onChange={() => toggle(id)} />
            <span className="name">{platName(id)}{id === settings.defaultPlatform ? '（默认）' : ''}</span>
            <span className="desc mono">{id}</span>
          </label>
        ))}
      </div>
      <div className="row-inline" style={{ marginTop: 10 }}>
        <label style={{ color: 'var(--mid)' }}>形态</label>
        <select aria-label="迁移形态" value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="auto">跟随设置</option>
          <option value="symlink">软链接</option>
          <option value="copy">实体复制</option>
        </select>
      </div>
      <div className="dlg-acts">
        <button className="btn ghost" onClick={onClose}>取消</button>
        <button className="btn" disabled={busy || !ids.size} onClick={ok}>{busy ? '迁移中…' : '迁移'}</button>
      </div>
    </Modal>
  );
}

// Skill 域设置的完整弹窗：订阅源 / 项目目录候选 / 迁移形态 / 默认平台 / 平台范围。
// 从「设置」页整体迁入——这些项只在 Skill 页里被用到，就地可改才是它们的场景；
// 设置页不再保留重复块（flat 单一入口，避免两处漂移）。
export function SkillSettingsDialog({ onClose }) {
  const { boot, patchUi, refreshBoot } = useStore();
  const toast = useToast();
  const guard = useGuard();
  const { dialog, node: dlgNode } = useDialog();
  const [hubInput, setHubInput] = useState('');
  const [projectInput, setProjectInput] = useState('');

  const s = boot?.settings || {};
  const adapters = boot?.adapters || [];
  const scope = new Set(s.platforms || []);

  const patch = (body) => guard(async () => {
    await api('/api/settings', { method: 'POST', body });
    await refreshBoot();
  });

  const addSource = () => guard(async () => {
    const p = hubInput.trim();
    if (!p) { toast('请输入订阅源目录'); return; }
    await api('/api/skills/sources', { method: 'POST', body: { path: p } });
    setHubInput('');
    patchUi({ source: '' });
    await refreshBoot();
  });

  const addProject = () => guard(async () => {
    const p = projectInput.trim();
    if (!p) { toast('请输入项目根目录'); return; }
    await api('/api/skills/project', { method: 'POST', body: { path: p } });
    setProjectInput('');
    await refreshBoot();
  });

  const removeCandidate = (kind, p) => guard(async () => {
    const ok = await dialog({ message: `移除${kind === 'hub' ? '订阅源' : '项目目录候选'}？\n${p}`, danger: true });
    if (!ok) return;
    await api(kind === 'hub' ? '/api/skills/sources' : '/api/skills/project', { method: 'DELETE', body: { path: p } });
    if (kind === 'hub' && s.skillHubPath === p) patchUi({ source: '' });
    await refreshBoot();
  });

  const togglePlatform = (id) => {
    const next = scope.has(id) ? [...scope].filter((x) => x !== id) : [...scope, id];
    if (!next.length) { toast('平台范围至少保留一个'); return; }
    let def = s.defaultPlatform;
    if (!next.includes(def)) def = next[0];
    patch({ platforms: next, defaultPlatform: def }).then(() => toast('已保存'));
  };

  const setDefaultPlatform = (id) => patch({
    defaultPlatform: id,
    platforms: [id, ...[...scope].filter((x) => x !== id)],
  }).then(() => toast('已保存'));

  const candidateRows = (list, kind) => (list || []).length ? list.map((p) => (
    <div key={p} className="row">
      <span className="name mono" title={p} style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }}>{p}</span>
      {kind === 'hub' && s.skillHubPath === p ? <span className="tag strong">主源</span> : null}
      <span className="acts">
        <button className="btn small ghost" onClick={() => removeCandidate(kind, p)}>移除</button>
      </span>
    </div>
  )) : <div className="row muted">（暂无）</div>;

  return (
    <Modal title="Skill 设置" onClose={onClose}>
      <div className="section-label">订阅源<span className="hint">目录下直接是各 skill；订阅源是唯一可信源（新增即设为主源）</span></div>
      <div className="list" style={{ border: '1px solid var(--soft-2)', borderRadius: 6 }}>
        {candidateRows(s.skillHubSources, 'hub')}
        <div className="row-inline" style={{ padding: 8 }}>
          <input aria-label="skill 目录绝对路径" placeholder="skill 目录绝对路径" spellCheck="false" value={hubInput} onChange={(e) => setHubInput(e.target.value)} />
          <button className="btn small" onClick={addSource}>订阅</button>
        </div>
      </div>

      <div className="section-label">项目目录候选<span className="hint">迁移目标所在的仓库根</span></div>
      <div className="list" style={{ border: '1px solid var(--soft-2)', borderRadius: 6 }}>
        {candidateRows(s.skillProjectCandidates, 'project')}
        <div className="row-inline" style={{ padding: 8 }}>
          <input aria-label="项目根目录" placeholder="项目根目录" spellCheck="false" value={projectInput} onChange={(e) => setProjectInput(e.target.value)} />
          <button className="btn small" onClick={addProject}>添加</button>
        </div>
      </div>

      <div className="section-label">平台与迁移<span className="hint">默认平台必须留在范围内</span></div>
      <div className="row-inline">
        <label style={{ color: 'var(--mid)', flex: '0 0 66px' }}>迁移形态</label>
        <select aria-label="迁移形态" value={s.skillSyncMode === 'copy' ? 'copy' : 'symlink'} onChange={(e) => patch({ skillSyncMode: e.target.value }).then(() => toast('已保存'))}>
          <option value="symlink">软链接（随订阅源实时变）</option>
          <option value="copy">复制（独立副本）</option>
        </select>
      </div>
      <div className="row-inline">
        <label style={{ color: 'var(--mid)', flex: '0 0 66px' }}>默认平台</label>
        <select aria-label="默认平台" value={s.defaultPlatform || 'claude-code'} onChange={(e) => setDefaultPlatform(e.target.value)}>
          {[...(scope.size ? scope : ['claude-code'])].map((id) => (
            <option key={id} value={id}>{(adapters.find((a) => a.id === id) || {}).name || id}</option>
          ))}
        </select>
      </div>
      <div className="row-inline">
        <label style={{ color: 'var(--mid)', flex: '0 0 66px' }}>平台范围</label>
        <span className="plats">
          {adapters.map((a) => (
            <button key={a.id} type="button" className={'pill' + (scope.has(a.id) ? ' on' : '')} onClick={() => togglePlatform(a.id)}>
              {(a.name || a.id).replace(/\s*\(.*\)$/, '').split(/[\s-]/)[0].toLowerCase()}
            </button>
          ))}
        </span>
      </div>

      {dlgNode}
      <div className="dlg-acts"><button className="btn ghost" onClick={onClose}>关闭</button></div>
    </Modal>
  );
}

// 检查订阅源：跨源实文件重复与冲突（GET /api/skills/hub-check 的弹窗形态）。
// 用途：sourceAudit 在线下的 CLI 渲染（skill hub check）；面板这里给一份可读报告。
// 只读，不落盘——每段下面写清处理建议，照着改就行。
const HUB_PROBLEM_LABEL = { missing: '不存在', empty: '空源', 'same-root': '重复根', nested: '嵌套订阅' };
const HUB_PROBLEM_TONE  = { missing: 'bad',    empty: 'bad',  'same-root': 'bad',    nested: 'bad' };

export function HubCheckDialog({ onClose }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  // tick 触发重查：避免 useCallback 闭包坑，effect 依赖 tick 即可
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setBusy(true); setErr('');
    api('/api/skills/hub-check')
      .then((r) => { if (alive) setD(r); })
      .catch((e) => { if (alive) setErr(String((e && e.message) || e)); })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [tick]);

  const { refreshBoot } = useStore();
  const toast = useToast();
  const guard = useGuard();
  const { dialog, node: dlgNode } = useDialog();

  // 快速删除：取消订阅该来源（订阅配置改动，不动磁盘上的 skill 文件）
  const removeSource = (path) => guard(async () => {
    const ok = await dialog({
      title: '取消订阅该来源',
      message: `确认取消订阅？\n${path}\n（订阅配置改动，不动磁盘上的 skill 文件）`,
      danger: true,
      okText: '取消订阅',
    });
    if (!ok) return;
    await api('/api/skills/sources', { method: 'DELETE', body: { path } });
    toast('已取消订阅');
    await refreshBoot();
    setTick((t) => t + 1); // 重查本弹窗
  });

  const conflicts = (d?.conflicts || []).filter((c) => !c.same);
  const duplicates = (d?.conflicts || []).filter((c) => c.same);
  const hubProblems = d?.hubProblems || [];

  // 冲突/重复里每个来源一行：md5 前缀 + 来源路径 + 主源标记 + 快速删除
  const renderEntry = (e) => (
    <div key={e.source} className="row" style={{ paddingLeft: 12 }}>
      <span className="tag" style={{ flex: '0 0 72px', fontFamily: 'ui-monospace, Consolas, monospace' }}>{e.md5.slice(0, 8)}</span>
      <Copyable className="desc mono" text={e.source} title="点击复制来源路径">{e.source}</Copyable>
      {e.current ? <span className="tag strong">主源</span> : null}
      <span className="acts">
        <button className="btn small ghost" title="取消订阅该来源（订阅配置改动，不动磁盘）" onClick={() => removeSource(e.source)}>删除</button>
      </span>
    </div>
  );

  return (
    <Modal title="检查订阅源" onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        {d ? (
          <span className={'tag' + (d.ok ? ' strong' : ' bad')}>
            {d.ok
              ? '全部健康'
              : `有 ${hubProblems.length + conflicts.length} 处需处理${duplicates.length ? `（另有 ${duplicates.length} 个内容一致的重复订阅）` : ''}`}
          </span>
        ) : <span className="muted">{busy ? '检查中…' : '等待…'}</span>}
        <span style={{ flex: 1 }} />
        <button className="btn small ghost" onClick={() => setTick((t) => t + 1)} disabled={busy}>
          {busy ? '检查中…' : '重新检查'}
        </button>
      </div>

      {err ? <div className="dlg-msg">检查失败：{err}</div> : null}

      {!d && !err ? <div className="muted">读取中…</div> : null}

      {d ? (
        <>
          <div className="vlegend">
            源 {d.summary.sources} 个 · 来源问题 {d.summary.hubProblems} · 跨源冲突 {d.summary.conflicts} · 内容一致的重复订阅 {d.summary.duplicates}
            {d.current ? <> · 主源 <code>{d.current}</code></> : null}
          </div>

          {hubProblems.length ? (
            <>
              <div className="section-label">来源配置问题<span className="hint">这些是「订阅配置」该修的，不是 skill 该修的</span></div>
              <div className="list" style={{ border: '1px solid var(--soft-2)', borderRadius: 6 }}>
                {hubProblems.map((p) => (
                  <div key={p.path + p.kind} className="row">
                    <span className={'tag ' + (HUB_PROBLEM_TONE[p.kind] || '')} style={{ flex: '0 0 72px', textAlign: 'center' }}>
                      {HUB_PROBLEM_LABEL[p.kind] || p.kind}
                    </span>
                    <Copyable className="desc mono" text={p.path} title="点击复制路径">{p.path}</Copyable>
                    <span className="muted" style={{ fontSize: 12, flex: '0 1 220px', textAlign: 'right' }}>{p.reason}</span>
                    <span className="acts">
                      <button className="btn small ghost" title="取消订阅该来源（订阅配置改动，不动磁盘）" onClick={() => removeSource(p.path)}>删除</button>
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : null}

          {conflicts.length ? (
            <>
              <div className="section-label">跨源冲突（内容不同）<span className="hint">同名出现在多个源、md5 不同。迁移会 blocked；保留一份实文件后用 <code>--source</code> 指定采用哪份</span></div>
              <div className="list" style={{ border: '1px solid var(--soft-2)', borderRadius: 6 }}>
                {conflicts.map((c) => (
                  <div key={c.name} style={{ padding: '8px 10px', borderBottom: '1px solid var(--soft-2)' }}>
                    <div className="row" style={{ marginBottom: 2 }}>
                      <span className="name" style={{ fontWeight: 700 }}>{c.name}</span>
                      <span className="tag bad">{c.entries.length} 个来源</span>
                    </div>
                    {c.entries.map(renderEntry)}
                  </div>
                ))}
              </div>
            </>
          ) : null}

          {duplicates.length ? (
            <>
              <div className="section-label">重复订阅（内容一致）<span className="hint">同名且 md5 相同。处理：保留一份，取消多余的订阅（<code>skill hub remove &lt;path&gt;</code>）</span></div>
              <div className="list" style={{ border: '1px solid var(--soft-2)', borderRadius: 6 }}>
                {duplicates.map((c) => (
                  <div key={c.name} style={{ padding: '8px 10px', borderBottom: '1px solid var(--soft-2)' }}>
                    <div className="row" style={{ marginBottom: 2 }}>
                      <span className="name" style={{ fontWeight: 700 }}>{c.name}</span>
                      <span className="tag">md5 {c.entries[0].md5.slice(0, 8)}</span>
                      <span className="tag">{c.entries.length} 个来源</span>
                    </div>
                    {c.entries.map(renderEntry)}
                  </div>
                ))}
              </div>
            </>
          ) : null}

          {!hubProblems.length && !conflicts.length && !duplicates.length ? (
            <div className="muted" style={{ padding: 8 }}>所有订阅源都健康，没有跨源冲突或重复订阅。</div>
          ) : null}
        </>
      ) : null}

      {dlgNode}
      <div className="dlg-acts" style={{ marginTop: 12 }}>
        <button className="btn ghost" onClick={onClose}>关闭</button>
      </div>
    </Modal>
  );
}
