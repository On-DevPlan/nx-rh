// Skill 页：中心 <-> 项目两侧列表、多选勾选（持久化）、平台 pill、比较、冲突选侧。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { useStore } from '../store.jsx';
import { useToast, useGuard, useDialog, Modal, DiffPre } from '../components/ui.jsx';

function shortLabel(adapterId, adapters) {
  const a = adapters.find((x) => x.id === adapterId);
  return (a ? a.name : adapterId).replace(/\s*\(.*\)$/, '').split(/[\s-]/)[0].toLowerCase();
}

// 项目内 pill 范围 = 设置范围 ∪ 旁系 skill 在用的平台 ∪ 自身平台（支持项目内平台迁移）
function pillScope(skill, projectSkills, settings, adapters) {
  const known = new Set(adapters.map((a) => a.id));
  const scope = new Set((settings?.platforms || []).filter((id) => known.has(id)));
  for (const x of projectSkills) for (const p of x.platforms || []) scope.add(p.id);
  for (const p of skill.platforms || []) scope.add(p.id);
  return [...scope];
}

export default function SkillsView() {
  const { boot, bundled, ui, patchUi, toggleSel, refreshBoot } = useStore();
  const toast = useToast();
  const guard = useGuard();
  const { dialog, node: dialogNode } = useDialog();
  const [centralSkills, setCentralSkills] = useState([]);
  const [projectSkills, setProjectSkills] = useState([]);
  const [compare, setCompare] = useState(null);
  const [modal, setModal] = useState(null);

  const settings = boot?.settings || {};
  const adapters = boot?.adapters || [];

  // 勾选集合：持久化在 ui.selCentral/selProject；数据刷新后过滤掉已不存在的名字
  const selCentral = useMemo(() => new Set(ui.selCentral), [ui.selCentral]);
  const selProject = useMemo(() => new Set(ui.selProject), [ui.selProject]);

  // 数据加载与勾选对账。关键点：对账必须等两侧数据真的到手（cs/ps 为当前选择的路径的结果），
  // 否则首次挂载时先到的一次空响应会把 localStorage 里持久化的勾选清掉。
  const loadSkills = useCallback(async () => {
    const centralPath = ui.central;
    const projectPath = ui.project;
    const [cs, ps] = await Promise.all([
      centralPath ? api(`/api/skills?side=central&path=${encodeURIComponent(centralPath)}`).catch(() => null) : [],
      projectPath ? api(`/api/skills?side=project&path=${encodeURIComponent(projectPath)}`).catch(() => null) : [],
    ]);
    if (centralPath) setCentralSkills(cs || []);
    if (projectPath) setProjectSkills(ps || []);
    // 勾选对账：请求成功（非 null）才允许修剪；闭包里的 sel 值可能与最新 state 有延迟，
    // 所以修剪条件是「勾选的名字已不在列表里」，写回用函数式 patch
    const cNames = new Set((cs || []).map((x) => x.name));
    const pNames = new Set((ps || []).map((x) => x.name));
    const staleC = ui.selCentral.filter((n) => !cNames.has(n));
    const staleP = ui.selProject.filter((n) => !pNames.has(n));
    if ((cs !== null && staleC.length) || (ps !== null && staleP.length)) {
      patchUi((u) => ({
        selCentral: cs !== null ? u.selCentral.filter((n) => cNames.has(n)) : u.selCentral,
        selProject: ps !== null ? u.selProject.filter((n) => pNames.has(n)) : u.selProject,
      }));
    }
  }, [ui.central, ui.project, ui.selCentral, ui.selProject, patchUi]);

  useEffect(() => { loadSkills(); }, [loadSkills]);

  const centralCandidates = settings.skillCentralCandidates || [];
  const projectCandidates = useMemo(() => {
    const map = new Map();
    for (const r of boot?.repos || []) map.set(r.path.toLowerCase(), { path: r.path, label: `${r.name}（仓库）  ·  ${r.path}` });
    for (const p of settings.skillProjectCandidates || []) {
      const k = p.toLowerCase();
      if (map.has(k)) map.get(k).label = map.get(k).label.replace('（仓库）', '（仓库+候选）');
      else map.set(k, { path: p, label: p.replace(/^.*[\\/]/, '') + '  ·  ' + p });
    }
    return [...map.values()];
  }, [boot?.repos, settings.skillProjectCandidates]);

  // 默认平台下拉选项（设置范围；范围空则兜底 claude-code）
  const platformOpts = useMemo(() => {
    const scope = (settings.platforms || []).filter((id) => adapters.some((a) => a.id === id));
    return scope.length ? scope : ['claude-code'];
  }, [settings.platforms, adapters]);

  const addCandidate = (kind) => guard(async () => {
    const p = await dialog({
      title: kind === 'central' ? '中心仓库绝对路径（根目录下直接是 skill 目录）' : '项目根目录绝对路径（已登记的仓库会自动出现在下拉里）',
      input: true,
    });
    if (!p) return;
    const list = await api('/api/candidates', { method: 'POST', body: { kind, path: p } });
    const newBoot = await api('/api/bootstrap');
    patchUi(kind === 'central'
      ? { central: list[list.length - 1] || '' }
      : { project: list[list.length - 1] || '' });
    // central add 同步设置当前中心路径（与 CLI skill central add 行为一致）
    if (kind === 'central' && list.length) {
      await api('/api/settings', { method: 'POST', body: { skillCentralPath: list[list.length - 1] } });
    }
    await refreshBoot();
    // refreshBoot 后 settings 更新，但 boot 未用于 central 候选展示——直接复用返回值
    void newBoot;
  });

  const removeCandidate = (kind) => guard(async () => {
    const cur = kind === 'central' ? ui.central : ui.project;
    if (!cur) return;
    const ok = await dialog({ message: `从候选移除${kind === 'central' ? '中心仓库' : '项目目录'}？\n${cur}\n（仅移出列表，不动磁盘）`, danger: true });
    if (!ok) return;
    const list = await api('/api/candidates', { method: 'POST', body: { kind, path: cur, remove: true } });
    if (kind === 'central') {
      patchUi({ central: list[0] || '' });
      await api('/api/settings', { method: 'POST', body: { skillCentralPath: list[0] || '' } });
    } else {
      patchUi({ project: list[list.length - 1] || '' });
    }
    await refreshBoot();
  });

  const onCentralChange = (path) => guard(async () => {
    patchUi({ central: path });
    await api('/api/settings', { method: 'POST', body: { skillCentralPath: path } });
  });

  const togglePlatform = (btn) => guard(async () => {
    const { name, adapter, on } = btn;
    if (!ui.project) { toast('请先选择项目目录'); return; }
    const body = { name, project: ui.project, adapter, enabled: on !== '1', force: false, mode: settings.skillSyncMode };
    let r = await api('/api/skills/platform', { method: 'POST', body });
    if (r.status === 'conflict') {
      const okc = await dialog({ message: `「${name}」在该平台已存在且内容不同（${r.files.length} 个文件）。\n用中心版本覆盖？` });
      if (!okc) return;
      r = await api('/api/skills/platform', { method: 'POST', body: { ...body, force: true } });
    }
    if (r.status === 'conflict') { toast('仍有冲突，未覆盖'); return; }
    if (r.status === 'blocked') { toast(r.reason); return; }
    const anchorNote = r.anchor?.converted ? `\n已自动物化「${r.anchor.converted.name}」作为实体锚点` : '';
    if (r.removed) toast(`${r.platform}：已关闭${anchorNote}`);
    else if (r.skipped) toast(`${r.platform}：已是最新`);
    else toast(`${r.platform}：已开启（${r.mode === 'symlink' ? '软链接 ' + (r.linkType || '') : '复制'}）`);
    await loadSkills();
  });

  const syncSkill = (name) => guard(async () => {
    if (!ui.project) { toast('请先选择项目目录'); return; }
    const adapter = settings.defaultPlatform || platformOpts[0];
    const r = await api('/api/skills/sync', {
      method: 'POST',
      body: { name, project: ui.project, adapter, mode: settings.skillSyncMode, force: false },
    });
    if (r.status === 'conflict') return openConflict(name);
    toast(r.skipped ? `已是最新（${r.linkType || '链接'}），跳过` : `已同步到 ${adapter}（${r.mode === 'symlink' ? '软链接 ' + (r.linkType || '') : '复制'}）`);
    await loadSkills();
  });

  const pushSkill = (name) => guard(async () => {
    if (!ui.project) { toast('请先选择项目目录'); return; }
    const r = await api('/api/skills/push', { method: 'POST', body: { name, project: ui.project, force: false } });
    if (r.status === 'conflict') return openConflict(name);
    toast(r.skipped ? r.reason : '已推送到中心');
    await loadSkills();
  });

  const openConflict = async (name) => {
    const detail = await api(`/api/skills/conflict?name=${encodeURIComponent(name)}&project=${encodeURIComponent(ui.project)}`);
    setModal({ title: `冲突详情 · ${name}`, node: (
      <ConflictDetail name={name} project={ui.project} data={detail} onDone={loadSkills} />
    ) });
  };

  const materialize = (name) => guard(async () => {
    const ok = await dialog({ message: `将「${name}」从链接转换为实体文件？转换后不再与中心实时同步。` });
    if (!ok) return;
    const r = await api('/api/skills/materialize', { method: 'POST', body: { name, project: ui.project } });
    toast(r.converted ? '已转换为实体文件' : r.message);
    await loadSkills();
  });

  const removeSkill = (name) => guard(async () => {
    const ok = await dialog({
      message: `从项目中删除 skill「${name}」？\n将移除它在所有平台目录下的副本与链接（中心仓库不受影响）。`,
      danger: true,
    });
    if (!ok) return;
    const r = await api('/api/skills/remove-project', { method: 'POST', body: { name, project: ui.project } });
    const anchorNote = r.anchor?.converted ? `\n已自动物化「${r.anchor.converted.name}」作为实体锚点` : '';
    toast(r.removed.length ? `已删除（${r.removed.map((x) => x.platform).join(', ')}）${anchorNote}` : r.reason);
    await loadSkills();
  });

  const doCompare = () => guard(async () => {
    if (!ui.project) { toast('请先选择项目目录'); return; }
    const names = [...new Set([...ui.selCentral, ...ui.selProject])];
    setCompare(await api('/api/skills/compare', {
      method: 'POST',
      body: { central: ui.central || undefined, project: ui.project, names },
    }));
  });

  const installBundled = () => guard(async () => {
    const skill = bundled?.skills.find((s) => s.name === 'repo-hub') || bundled?.skills[0];
    if (!skill) { toast('包内没有内置 skill'); return; }
    const r = await api('/api/bundled/install', { method: 'POST', body: { name: skill.name, force: false } });
    if (r.status === 'conflict') {
      const ok = await dialog({ message: `目标已存在且内容不同（${r.count} 个文件）:\n${r.path}\n\n覆盖为包内版本？` });
      if (!ok) return;
      const forced = await api('/api/bundled/install', { method: 'POST', body: { name: skill.name, force: true } });
      toast(`${forced.replaced ? '已更新' : '已安装'} → ${forced.path}`);
    } else if (r.skipped) {
      toast(`已是最新，无需安装\n${r.path}`);
    } else {
      toast(`${r.replaced ? '已更新' : '已安装'}（${r.files} 个文件）\n${r.path}`);
    }
  });

  const projectStateTag = (s) => {
    const c = centralSkills.find((x) => x.name === s.name);
    if (!c) return <span className="tag">本地</span>;
    if ((s.platforms || []).some((p) => p.linkType)) return <span className="tag strong">链接</span>;
    return c.md5 === s.md5 ? <span className="tag strong">一致</span> : <span className="tag bad">冲突</span>;
  };

  const relationTag = (c) => {
    const proj = projectSkills.find((s) => s.name === c.name);
    if (!proj) return <span className="tag">仅中心</span>;
    if ((proj.platforms || []).some((p) => p.linkType)) return <span className="tag strong">链接</span>;
    return proj.md5 === c.md5 ? <span className="tag strong">一致</span> : <span className="tag bad">冲突</span>;
  };

  return (
    <>
      <div className="toolbar">
        <label>中心</label>
        <select className="grow" value={ui.central} onChange={(e) => onCentralChange(e.target.value)}>
          {centralCandidates.length
            ? centralCandidates.map((p) => <option key={p} value={p}>{p.replace(/^.*[\\/]/, '')}  ·  {p}</option>)
            : <option value="">（请先添加中心仓库）</option>}
        </select>
        <button className="btn ghost" title="添加中心仓库目录" onClick={() => addCandidate('central')}>＋</button>
        <button className="btn ghost" title="从候选移除" onClick={() => removeCandidate('central')}>－</button>
        <span className="sep"></span>
        <label>项目</label>
        <select className="grow" value={ui.project} onChange={(e) => patchUi({ project: e.target.value })}>
          {projectCandidates.length
            ? projectCandidates.map((o) => <option key={o.path} value={o.path}>{o.label}</option>)
            : <option value="">（请先登记仓库或添加项目目录）</option>}
        </select>
        <button className="btn ghost" title="添加项目目录" onClick={() => addCandidate('project')}>＋</button>
        <button className="btn ghost" title="从候选移除" onClick={() => removeCandidate('project')}>－</button>
      </div>
      <div className="toolbar">
        <label>默认平台</label>
        <select value={settings.defaultPlatform || platformOpts[0]}
          onChange={(e) => guard(async () => {
            const id = e.target.value;
            await api('/api/settings', {
              method: 'POST',
              body: { defaultPlatform: id, platforms: [id, ...(settings.platforms || []).filter((x) => x !== id)] },
            });
            await refreshBoot();
          })}>
          {platformOpts.map((id) => (
            <option key={id} value={id}>{(adapters.find((a) => a.id === id) || {}).name || id}</option>
          ))}
        </select>
        <span className="sep"></span>
        <label>同步模式</label>
        <select value={settings.skillSyncMode === 'copy' ? 'copy' : 'symlink'}
          onChange={(e) => guard(async () => {
            await api('/api/settings', { method: 'POST', body: { skillSyncMode: e.target.value } });
            await refreshBoot();
          })}>
          <option value="symlink">软链接</option>
          <option value="copy">复制</option>
        </select>
        <span className="sep"></span>
        <button className="btn" onClick={doCompare}>比较选中</button>
        <button className="btn ghost" onClick={() => guard(loadSkills)}>刷新</button>
        <button className="btn ghost" onClick={installBundled}>安装 repo-hub skill</button>
        {bundled ? <span className="muted">{bundled.skills.map((x) => `${x.name}(${x.files})`).join(' ')} → {bundled.defaultDir}</span> : null}
      </div>

      <div className="cols">
        <div className="col">
          <div className="colhead">
            <h3>中心仓库</h3>
            <span className="muted">{centralSkills.length ? `${centralSkills.length} 个` : ''}</span>
          </div>
          <div className="card list">
            {centralSkills.length ? centralSkills.map((c) => (
              <div key={c.name} className="row">
                <input type="checkbox" checked={selCentral.has(c.name)} onChange={() => toggleSel('selCentral', c.name)} />
                <span className="name">{c.name}</span>
                <span className="desc">{c.description}</span>
                {relationTag(c)}
                <span className="acts">
                  <button className="btn small ghost" onClick={() => syncSkill(c.name)}>同步到项目</button>
                </span>
              </div>
            )) : <div className="row muted">（中心仓库暂无 skill；中心根目录下直接放 skill 目录即可）</div>}
          </div>
        </div>
        <div className="col">
          <div className="colhead">
            <h3>项目 skill</h3>
            <span className="muted">{projectSkills.length ? `${projectSkills.length} 个 · 默认平台 ${settings.defaultPlatform || 'claude-code'}` : ''}</span>
          </div>
          <div className="card list">
            {projectSkills.length ? projectSkills.map((s) => {
              const scope = pillScope(s, projectSkills, settings, adapters);
              const on = new Set((s.platforms || []).map((p) => p.id));
              const isLink = (s.platforms || []).some((p) => p.linkType);
              return (
                <div key={s.name} className="row">
                  <input type="checkbox" checked={selProject.has(s.name)} onChange={() => toggleSel('selProject', s.name)} />
                  <span className="name">{s.name}</span>
                  {projectStateTag(s)}
                  <span className="plats">
                    {scope.map((id) => {
                      const p = (s.platforms || []).find((x) => x.id === id);
                      const isOn = !!p;
                      const cls = 'pill' + (isOn ? (p.linkType ? ' on lnk' : ' on real') : '');
                      return (
                        <button key={id} className={cls}
                          title={`${(adapters.find((a) => a.id === id) || {}).name || id}${isOn ? '（已提供 · ' + (p.linkType ? p.linkType + ' 链接' : '实体') + '）' : '（未提供）'}`}
                          onClick={() => togglePlatform({ name: s.name, adapter: id, on: isOn ? '1' : '0' })}>
                          {shortLabel(id, adapters)}
                        </button>
                      );
                    })}
                  </span>
                  <span className="acts">
                    <button className="btn small ghost" onClick={() => pushSkill(s.name)}>推送到中心</button>
                    {isLink ? <button className="btn small ghost" onClick={() => materialize(s.name)}>转实体</button> : null}
                    <button className="btn small ghost danger" onClick={() => removeSkill(s.name)}>删除</button>
                  </span>
                </div>
              );
            }) : <div className="row muted">（项目侧暂无 skill；从中心同步，或勾选平台小按钮）</div>}
          </div>
        </div>
      </div>

      {compare ? (
        <div className="card">
          <div className="colhead"><h3>比较结果</h3><span className="muted">
            共 {compare.summary.total} · 一致 {compare.summary.same} · 链接 {compare.summary.linked} · 冲突 {compare.summary.differ} · 仅中心 {compare.summary.onlyCentral} · 仅项目 {compare.summary.onlyProject}
          </span></div>
          <div className="list">
            {compare.rows.length ? compare.rows.map((r) => {
              const mark = { same: '一致', linked: '链接', differ: '冲突', 'only-central': '仅中心', 'only-project': '仅项目' }[r.state];
              return (
                <div key={r.name} className="row">
                  <span className="name">{r.name}</span>
                  <span className="desc">{r.description}</span>
                  {r.platforms.length ? (
                    <span className="plats">{r.platforms.map((p) => <span key={p.id} className="pill on">{shortLabel(p.id, adapters)}</span>)}</span>
                  ) : null}
                  <span className="acts">
                    <span className={'tag' + (r.state === 'differ' ? ' bad' : r.state === 'same' || r.state === 'linked' ? ' strong' : '')}>{mark}</span>
                    {r.state === 'differ' ? <button className="btn small ghost" onClick={() => guard(() => openConflict(r.name))}>差异</button> : null}
                  </span>
                </div>
              );
            }) : <div className="row muted">（没有可比较的 skill）</div>}
          </div>
        </div>
      ) : null}

      <div className="cli-hint">
        CLI 等价：nx-rh skill compare --central C --project P · nx-rh skill platform-set &lt;name&gt; --project P --adapter A [--off] · nx-rh skill sync &lt;name&gt; --project P
      </div>

      {modal ? <Modal title={modal.title} onClose={() => setModal(null)}>{modal.node}</Modal> : null}
      {dialogNode}
    </>
  );
}

// 冲突详情（按文件选侧），作为弹窗内容组件
function ConflictDetail({ name, project, data, onDone }) {
  const guard = useGuard();
  if (!data.files.length) return <div>两侧一致，无差异</div>;
  return (
    <>
      {data.files.map((f) => (
        <div key={f.file} className="conflict-file">
          <div className="cf-head">
            <span>{f.file} ({f.side})</span>
            {f.side === 'both-differ' ? (
              <span>
                <button className="btn small" onClick={() => guard(async () => {
                  await api('/api/skills/apply', { method: 'POST', body: { name, project, file: f.file, side: 'central' } });
                  await onDone();
                })}>用中心版</button>
                <button className="btn small ghost" style={{ marginLeft: 6 }} onClick={() => guard(async () => {
                  await api('/api/skills/apply', { method: 'POST', body: { name, project, file: f.file, side: 'project' } });
                  await onDone();
                })}>用项目版</button>
              </span>
            ) : null}
          </div>
          {f.diff ? <DiffPre text={f.diff} /> : null}
        </div>
      ))}
    </>
  );
}
