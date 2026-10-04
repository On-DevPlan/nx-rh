// Skill 页：以「订阅源（Skill Hub）」为唯一可信源，把 skill 迁移到各平台目录。
//
// 单向流：订阅源 → 目标（迁移）；目标 → 订阅源（提交）。
// 不做「项目之间互迁」——项目目录只是落地副本。
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { useStore } from '../../web/frontend/store.jsx';
import { useToast, useGuard, useDialog, Modal, Copyable } from '../../web/frontend/components/ui.jsx';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';

const SCOPE_SHORT = { user: '用户', project: '项目' };

function shortLabel(adapterId, adapters) {
  const a = adapters.find((x) => x.id === adapterId);
  return (a ? a.name : adapterId).replace(/\s*\(.*\)$/, '').split(/[\s-]/)[0].toLowerCase();
}

// ---- skill 编辑器：新建 / 编辑共用（面板里的 C 与 U） ----
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
          <input
            style={{ flex: 1 }}
            placeholder="skill 名（小写连字符，如 my-skill）"
            value={name}
            spellCheck="false"
            onChange={(e) => setName(e.target.value)}
          />
          <input
            style={{ flex: 2 }}
            placeholder="一句话描述（写入 frontmatter）"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
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
          isEdit
            ? ''
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

export default function SkillsView() {
  const { boot, ui, patchUi, toggleSel, refreshBoot } = useStore();
  const toast = useToast();
  const guard = useGuard();
  const { dialog, node: dialogNode } = useDialog();

  const [data, setData] = useState(null);
  const [modal, setModal] = useState(null);

  const settings = boot?.settings || {};
  const adapters = boot?.adapters || [];
  const source = ui.source || '';

  // 项目 = 右上角激活的目录（无则服务进程目录）。项目级信息只针对它。
  // 必须声明在 load 之前——load 的依赖数组引用它，声明在后就是 TDZ 白屏。
  const project = ui.activeScope?.path || boot?.projectRoot || '';

  const load = useCallback(async () => {
    const qs = new URLSearchParams();
    if (project) qs.set('project', project);
    if (source) qs.set('source', source);
    const d = await api('/api/skills?' + qs.toString()).catch(() => null);
    setData(d);
  }, [project, source]);

  useEffect(() => { load(); }, [load]);

  const sources = data?.sources || boot?.sources || [];
  const platformOpts = useMemo(
    () => (settings.platforms || []).filter((id) => adapters.some((a) => a.id === id)),
    [settings.platforms, adapters]
  );

  // 勾选集合（持久化）。只在「当前列表里还存在的名字」上生效，避免旧勾选残留。
  const selSkills = useMemo(() => new Set(ui.selSkills), [ui.selSkills]);
  const hubNames = useMemo(() => (data?.skills || []).map((s) => s.name), [data]);
  const orphanNames = useMemo(() => (data?.orphans || []).map((s) => s.name), [data]);
  const selectedNames = useMemo(
    () => ui.selSkills.filter((n) => hubNames.includes(n) || orphanNames.includes(n)),
    [ui.selSkills, hubNames, orphanNames]
  );
  const selectedHub = useMemo(() => selectedNames.filter((n) => hubNames.includes(n)), [selectedNames, hubNames]);
  const selectedOrphans = useMemo(() => selectedNames.filter((n) => orphanNames.includes(n)), [selectedNames, orphanNames]);
  const allSelected = hubNames.length > 0 && hubNames.every((n) => selSkills.has(n));
  const toggleAll = () => patchUi({ selSkills: allSelected ? [] : hubNames });

  // 批量迁移：有勾选就只迁勾选的，没勾选就全量（--all）。
  // 全量前必须确认——「避免手点」不等于「允许误点」。
  const bulkMigrate = (to) => guard(async () => {
    const names = selectedHub;
    const total = names.length || hubNames.length;
    if (!total) { toast('没有可迁移的 skill'); return; }
    const ok = await dialog({
      message: `将${names.length ? `勾选的 ${names.length} 个` : `全部 ${total} 个`} skill 迁移到${SCOPE_SHORT[to]}？\n平台: ${platformOpts.join(', ')} · 形态: ${settings.skillSyncMode === 'copy' ? '复制' : '软链接'}`,
    });
    if (!ok) return;
    const body = names.length
      ? { name: names, to, platform: 'all', project, mode: settings.skillSyncMode }
      : { all: true, to, platform: 'all', project, mode: settings.skillSyncMode };
    const r = await api('/api/skills/migrate', { method: 'POST', body });
    if (r.status === 'blocked') {
      toast(`${r.blocked.length} 处被阻止：同名 skill 在多个订阅源且内容不同（先解决订阅）`);
    } else {
      toast(`已迁移 ${r.migrated} 处（跳过 ${r.skipped}）`);
    }
    await load();
  });

  // 撤销只对勾选生效：全量撤销会把用户级目录里所有链接一并清掉，风险不对等
  const bulkUnmigrate = () => guard(async () => {
    if (!selectedNames.length) { toast('请先勾选要撤销的 skill'); return; }
    const ok = await dialog({
      message: `撤销勾选的 ${selectedNames.length} 个 skill 的迁移？\n链接直接删除；实体副本会被跳过（需逐个确认）。`,
      danger: true,
    });
    if (!ok) return;
    const r = await api('/api/skills/unmigrate', { method: 'POST', body: { name: selectedNames, to: 'all', platform: 'all', project } });
    toast(r.status === 'blocked' ? `${r.needForce.length} 处是实体副本，已跳过` : `已撤销 ${r.removed.length} 处`);
    await load();
  });

  // 批量提交：优先勾选的「未入 Hub」；没勾选就是全部游离 skill
  const bulkSubmit = () => guard(async () => {
    if (!source && !data?.hub?.path) { toast('请先订阅一个 skill 目录'); return; }
    const body = selectedOrphans.length
      ? { name: selectedOrphans, to: 'project', platform: 'all', project }
      : { all: true, to: 'project', platform: 'all', project };
    const n = selectedOrphans.length || orphanNames.length;
    if (!n) { toast('没有未入 Hub 的 skill'); return; }
    const ok = await dialog({
      message: `把${selectedOrphans.length ? `勾选的 ${n} 个` : `全部 ${n} 个「未入 Hub」的`} skill 提交到订阅源？\n提交后会删除目标实文件并改回链接。`,
    });
    if (!ok) return;
    const r = await api('/api/skills/submit', { method: 'POST', body });
    toast(`已提交 ${r.submitted} 个（跳过 ${r.skipped}）`);
    await load();
    await refreshBoot();
  });

  // ---- 订阅源操作 ----
  const addSource = () => guard(async () => {
    const p = await dialog({ title: '订阅一个 skill 目录（目录下直接是各 skill）', input: true });
    if (!p) return;
    await api('/api/skills/sources', { method: 'POST', body: { path: p } });
    patchUi({ source: '' });
    await refreshBoot();
    await load();
  });

  const removeSource = () => guard(async () => {
    const cur = source || data?.hub?.path;
    if (!cur) return;
    const ok = await dialog({ message: `取消订阅该目录？（不动磁盘）\n${cur}`, danger: true });
    if (!ok) return;
    await api('/api/skills/sources', { method: 'DELETE', body: { path: cur } });
    patchUi({ source: '' });
    await refreshBoot();
    await load();
  });

  const setSetting = (patch) => guard(async () => {
    await api('/api/settings', { method: 'POST', body: patch });
    await refreshBoot();
    await load();
  });

  // ---- 迁移 / 撤销 ----
  const toggleCell = (name, cell) => guard(async () => {
    const base = { name, to: cell.scope, platform: cell.platform, project };
    if (cell.on) {
      let r = await api('/api/skills/unmigrate', { method: 'POST', body: base });
      if (r.status === 'blocked') {
        const ok = await dialog({
          message: `「${name}」在 ${SCOPE_SHORT[cell.scope]}·${cell.platform} 是实体副本（可能含本地改动）。\n删除不可逆，确认？`,
          danger: true,
        });
        if (!ok) return;
        r = await api('/api/skills/unmigrate', { method: 'POST', body: { ...base, force: true } });
      }
      toast(r.removed?.length ? `已撤销 ${SCOPE_SHORT[cell.scope]}·${cell.platform}` : '该目标本就没有');
    } else {
      // 目的仓库不做冲突检测：订阅源是唯一真相源，直接覆盖（hub 里永远有一份，可恢复）。
      // 真正要检测的是订阅源之间——那个用 skill hub check。
      const r = await api('/api/skills/migrate', {
        method: 'POST',
        body: { ...base, mode: settings.skillSyncMode },
      });
      if (r.status === 'blocked') {
        toast(`${name} 在多个订阅源且内容不同，先解决订阅（skill hub check）`);
        await load();
        return;
      }
      toast(`已迁移到 ${SCOPE_SHORT[cell.scope]}·${cell.platform}`);
    }
    await load();
  });

  const migrateScope = (name, to) => guard(async () => {
    const r = await api('/api/skills/migrate', {
      method: 'POST',
      body: { name, to, platform: 'all', project, mode: settings.skillSyncMode },
    });
    toast(r.status === 'blocked' ? '同名 skill 在多个订阅源且内容不同，先解决订阅' : `已迁移到${SCOPE_SHORT[to]}`);
    await load();
  });

  // to 缺省 'project'；未入 Hub 的行点勋章时会带自己的作用域进来（实文件在哪就从哪提交）
  const submit = (name, to = 'project') => guard(async () => {
    const cur = source || data?.hub?.path;
    if (!cur) { toast('请先订阅一个 skill 目录'); return; }
    const r = await api('/api/skills/submit', { method: 'POST', body: { name, to, platform: 'all', project } });
    if (r.status === 'conflict') {
      const ok = await dialog({ message: `订阅源已有同名 skill 且内容不同（${r.files.length} 个文件）。\n用这份副本覆盖订阅源？` });
      if (!ok) return;
      await api('/api/skills/submit', { method: 'POST', body: { name, to, platform: 'all', project, force: true } });
    }
    toast(`已提交到订阅源，目标实文件已删除`);
    await load();
    await refreshBoot();
  });

  const showContext = (name) => guard(async () => {
    const d = await api('/api/skills/content?name=' + encodeURIComponent(name));
    setModal({
      title: `skill 上下文 · ${name}`,
      node: (
        <>
          <div className="muted" style={{ marginBottom: 8 }}>
            来源: {d.source} · {d.contentBytes} 字节
            <button className="btn small" style={{ marginLeft: 12 }} onClick={() => {
              navigator.clipboard?.writeText(d.content);
              toast('已复制 SKILL.md');
            }}>复制全文</button>
          </div>
          {(d.outline?.length) ? (
            <div className="muted" style={{ marginBottom: 8, maxHeight: 120, overflow: 'auto' }}>
              {d.outline.map((h, i) => (
                <div key={i} style={{ paddingLeft: (h.level - 1) * 14 }}>
                  {'#'.repeat(h.level)} {h.text}
                </div>
              ))}
            </div>
          ) : null}
          <pre>{d.content}</pre>
        </>
      ),
    });
  });

  const hubPath = data?.hub?.path || boot?.hub?.path || '';

  // 「未入 Hub」两组：当前项目一组（按项目目录收拢，不看平台），用户级一组。
  // 一个 skill 同时在项目与用户级存在时归项目组——那是更该处理的一侧，
  // 用户级形态仍能在详情弹窗里看到并单独操作。
  const orphanGroups = useMemo(() => {
    const projName = String(project || '').replace(/^.*[\\/]/, '');
    const mk = (key, scope, label) => ({ key, scope, label, dirs: new Set(), items: [] });
    const proj = mk('project', 'project', projName ? `项目 · ${projName}` : '项目');
    const user = mk('user', 'user', '用户级');
    for (const o of data?.orphans || []) {
      const cells = (o.cells || []).filter((c) => platformOpts.includes(c.platform));
      if (!cells.length) continue;
      const hasProj = cells.some((c) => c.scope === 'project');
      const g = hasProj ? proj : user;
      g.items.push(o);
      for (const c of cells) {
        if ((c.scope === 'project') === hasProj) g.dirs.add(String(c.dir || '').replace(/[\\/][^\\/]+$/, ''));
      }
    }
    // 项目组在前；用户级游离大多是本机常驻旧副本，属于次要信息
    return [proj, user].filter((g) => g.items.length);
  }, [data, platformOpts, project]);

  // 分组各自的展开状态（会话级，不持久化）：默认项目组展开、用户组收起
  const [groupOpen, setGroupOpen] = useState({});
  const isGroupOpen = (g) => groupOpen[g.key] ?? g.scope === 'project';
  const toggleGroup = (g) => setGroupOpen((m) => ({ ...m, [g.key]: !isGroupOpen(g) }));

  // 未入 Hub 默认收起（ui.orphansOpen）：它只是「待收敛」的提示，不是日常要看的信息。
  // 收起时表头仍给出数量与作用域分布，不至于完全丢信息。
  const orphansOpen = !!ui.orphansOpen;
  const orphanProjCount = orphanGroups.find((g) => g.scope === 'project')?.items.length || 0;
  const orphanUserCount = orphanGroups.find((g) => g.scope === 'user')?.items.length || 0;
  const orphanCount = orphanProjCount + orphanUserCount;

  // ---- 详情弹窗：查看 + 操作都收进来，行上只留一个入口（轻量） ----
  const closeModal = () => setModal(null);
  const reloadAll = useCallback(async () => { await load(); await refreshBoot(); }, [load, refreshBoot]);

  // 新建（C）：写入当前订阅源
  const openCreate = () => {
    setModal({
      title: '新建 skill（写入当前订阅源）',
      node: <SkillEditor mode="create" close={closeModal} reload={reloadAll} />,
    });
  };

  // 编辑（U）：载入 SKILL.md 全文，改完 PATCH 回去
  const openEditor = (s) => guard(async () => {
    const d = await api('/api/skills/content?name=' + encodeURIComponent(s.name));
    setModal({
      title: `编辑 skill · ${s.name}`,
      node: (
        <SkillEditor
          mode="edit"
          skill={{ name: s.name, description: s.description, content: d.content }}
          close={closeModal}
          reload={reloadAll}
        />
      ),
    });
  });

  // 删除（D）：目标侧还有引用时先 blocked，确认后才删
  const doDelete = (s) => guard(async () => {
    const ok = await dialog({ message: `从订阅源删除「${s.name}」？`, danger: true });
    if (!ok) return;
    const r = await api('/api/skills/' + encodeURIComponent(s.name), { method: 'DELETE', body: {} });
    if (r.status === 'blocked') {
      const ok2 = await dialog({
        message: `${r.reason}：\n${r.refs.map((x) => `${SCOPE_SHORT[x.scope]}·${x.platform} ${x.path}`).join('\n')}\n仍要删除？（目标侧会悬空，之后可用迁移重建）`,
        danger: true,
      });
      if (!ok2) return;
      await api('/api/skills/' + encodeURIComponent(s.name), { method: 'DELETE', body: { force: true } });
    }
    closeModal();
    await reloadAll();
    toast('已删除');
  });

  const openDetail = (s, { orphan } = {}) => {
    const cells = (s.cells || []).filter((c) => platformOpts.includes(c.platform));
    const node = (
      <>
        <div className="muted" style={{ marginBottom: 10 }}>{s.description}</div>
        {!orphan && s.source ? (
          <div className="muted" style={{ marginBottom: 6 }}>
            来源: <Copyable text={s.source}>{s.source}</Copyable>
            {s.dir ? <> · 目录: <Copyable text={s.dir}>{s.dir}</Copyable></> : null}
          </div>
        ) : null}
        {s.conflict && !s.conflict.same ? (
          <div style={{ marginBottom: 10 }}>
            <span
              className="tag bad"
              title={s.conflict.sources.map((x) => x.path).join('\n')}
            >
              跨源冲突：同名实文件在多个订阅源且内容不同，迁移会被阻止（skill hub check）
            </span>
          </div>
        ) : null}

        {(s.outline?.length) ? (
          <>
            <div className="colhead">
              <h3>结构</h3>
              <span className="muted">{s.stats?.sections ?? s.outline.length} 节 · {s.stats?.lines ?? '?'} 行 · {s.stats?.bytes ?? '?'} 字节</span>
            </div>
            <div className="list" style={{ maxHeight: 180, overflow: 'auto', marginBottom: 12 }}>
              {s.outline.map((h, i) => (
                <div key={i} className="row" style={{ paddingLeft: 12 + (h.level - 1) * 16 }}>
                  <span className="name" style={{ fontWeight: h.level === 1 ? 700 : 500 }}>
                    <span className="muted" style={{ marginRight: 6 }}>{'#'.repeat(h.level)}</span>
                    {h.text}
                  </span>
                  <span className="acts muted">L{h.line}</span>
                </div>
              ))}
            </div>
          </>
        ) : null}

        <div className="colhead"><h3>平台落点与操作</h3></div>
        <div className="list">
          {cells.length ? cells.map((c) => (
            <div key={c.scope + c.platform} className="row">
              <span className="name">{SCOPE_SHORT[c.scope]}·{shortLabel(c.platform, adapters)}</span>
              <Copyable className="desc" text={c.dir} title="点击复制落点路径">{c.dir}</Copyable>
              <span
                className={'tag' + (c.on ? (c.linkType ? '' : ' strong') : ' bad')}
                title={c.on ? (c.linkType ? '软链接，随订阅源实时同步' : '实体副本') : '尚未迁移'}
              >
                {c.on ? (c.linkType ? '链接' : '实体') : '未迁移'}
              </span>
              <span className="acts">
                {c.on ? (
                  <button className="btn small ghost" onClick={() => { closeModal(); toggleCell(s.name, c); }}>撤销</button>
                ) : (
                  <button className="btn small" onClick={() => { closeModal(); toggleCell(s.name, c); }}>迁移</button>
                )}
              </span>
            </div>
          )) : <div className="row muted">（当前启用的平台没有落点）</div>}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          {orphan ? (
            <button className="btn" onClick={() => { closeModal(); submit(s.name); }}>提交到 Hub</button>
          ) : (
            <>
              <button className="btn" onClick={() => { closeModal(); migrateScope(s.name, 'project'); }}>迁移 → 项目</button>
              <button className="btn" onClick={() => { closeModal(); migrateScope(s.name, 'user'); }}>迁移 → 用户</button>
              <button className="btn ghost" onClick={() => openEditor(s)}>编辑</button>
              <button className="btn danger" onClick={() => doDelete(s)}>删除</button>
            </>
          )}
          <button className="btn ghost" onClick={() => showContext(s.name)}>查看全文</button>
        </div>
      </>
    );
    setModal({ title: `skill · ${s.name}`, node });
  };

  // 行上的状态只用**一个**标签表达：勋章按「平台 × 作用域」线性膨胀（2 平台 4 个、
  // 4 平台 8 个），行里根本放不下。逐落点的迁移 / 撤销归详情页的竖向列表。
  const rowCells = (s) => (s.cells || []).filter((c) => platformOpts.includes(c.platform));
  const cellState = (s, orphan) => {
    const cells = rowCells(s);
    if (!cells.length) return '—';
    if (orphan) return `${cells.length} 处`;
    const on = cells.filter((c) => c.on).length;
    return on ? `已迁移 ${on}/${cells.length}` : '未迁移';
  };
  const cellSummary = (s) =>
    rowCells(s)
      .map((c) => `${SCOPE_SHORT[c.scope]}·${c.platformName || shortLabel(c.platform, adapters)}：${c.on ? (c.linkType || '实体') : '未迁移'}`)
      .join('\n');

  const renderRow = (s, { orphan } = {}) => (
    <div
      key={s.name}
      className="row"
      style={{ cursor: 'pointer' }}
      title="点击查看详情与操作（逐落点的迁移 / 撤销在里面）"
      onClick={() => openDetail(s, { orphan })}
    >
      <input
        type="checkbox"
        checked={selSkills.has(s.name)}
        title="勾选后可用于批量操作"
        onClick={(e) => e.stopPropagation()}
        onChange={() => toggleSel('selSkills', s.name)}
      />
      <span className="name">{s.name}</span>
      <span className="desc">{s.description}</span>
      {orphan ? (
        <span className="tag bad" title="不在订阅源里，实文件散落在平台目录">未入 Hub</span>
      ) : s.conflict && !s.conflict.same ? (
        <span
          className="tag bad"
          title={`同名 skill 在多个订阅源且内容不同：${s.conflict.sources.map((x) => x.path).join('\n')}\n迁移会被阻止，先解决订阅或用 --source 指定`}
        >
          跨源冲突
        </span>
      ) : s.conflict ? (
        <span className="tag" title={`同名实文件在多个订阅源（内容一致）:\n${s.conflict.sources.map((x) => x.path).join('\n')}`}>
          重复订阅
        </span>
      ) : (
        <span className="tag" title={s.alsoIn?.length ? '同时存在于: ' + s.alsoIn.join(', ') : '来源目录'}>
          {(s.source || '').replace(/^.*[\\/]/, '')}
        </span>
      )}
      {/* 一个汇总标签（不随平台数膨胀），明细与逐落点操作在详情页的竖向列表里 */}
      <span
        className={'tag' + (orphan ? ' bad' : rowCells(s).length && rowCells(s).every((c) => c.on) ? ' strong' : '')}
        title={cellSummary(s) || '当前启用的平台没有落点'}
      >
        {cellState(s, orphan)}
      </span>
      <span className="acts">
        <button
          className="btn small ghost"
          onClick={(e) => { e.stopPropagation(); openDetail(s, { orphan }); }}
        >
          详情
        </button>
      </span>
    </div>
  );

  return (
    <>
      <div className="toolbar">
        <label>订阅源</label>
        <select className="grow" value={source} onChange={(e) => patchUi({ source: e.target.value })}>
          <option value="">（当前主源）{hubPath ? '  ·  ' + hubPath : ''}</option>
          {sources.map((s) => (
            <option key={s.path} value={s.path}>{s.path.replace(/^.*[\\/]/, '')}  ·  {s.path}  ({s.count})</option>
          ))}
        </select>
        <button className="btn ghost" title="订阅 skill 目录" onClick={addSource}>＋</button>
        <button className="btn ghost" title="取消订阅" onClick={removeSource}>－</button>
        <span className="muted">
          项目在右上角「最近目录」切换：项目级信息只针对激活的那个目录
        </span>
      </div>
      <div className="toolbar">
        <label>默认平台</label>
        <select value={settings.defaultPlatform || platformOpts[0]}
          onChange={(e) => setSetting({ defaultPlatform: e.target.value })}>
          {platformOpts.map((id) => (
            <option key={id} value={id}>{(adapters.find((a) => a.id === id) || {}).name || id}</option>
          ))}
        </select>
        <span className="sep"></span>
        <label>迁移形态</label>
        <select value={settings.skillSyncMode === 'copy' ? 'copy' : 'symlink'}
          onChange={(e) => setSetting({ skillSyncMode: e.target.value })}>
          <option value="symlink">软链接</option>
          <option value="copy">复制</option>
        </select>
        <span className="sep"></span>
        <button className="btn ghost" onClick={() => guard(load)}>刷新</button>
        {data?.hub && !data.hub.path ? <span className="muted">尚未订阅 Skill Hub</span> : null}
      </div>
      <div className="toolbar">
        <label>批量</label>
        <button className="btn" onClick={() => bulkMigrate('project')}>→项目</button>
        <button className="btn" onClick={() => bulkMigrate('user')}>→用户</button>
        <button className="btn ghost" onClick={bulkUnmigrate}>撤销勾选</button>
        <button className="btn ghost" onClick={bulkSubmit}>提交未入 Hub</button>
        <span className="muted">
          已勾选 {selectedNames.length} 个{selectedNames.length ? '' : '（不勾选则「→项目/→用户」为全量）'}
        </span>
      </div>

      <div className="card">
        <div className="colhead">
          <h3>订阅源 Skill</h3>
          <span className="muted">
            <input type="checkbox" checked={allSelected} title="全选 / 全不选" onChange={toggleAll} />
            {' '}
            {hubPath ? `${hubPath} · ` : ''}{data?.skills?.length ?? 0} 个
            {hubPath ? (
              <button className="btn small" style={{ marginLeft: 10 }} title="在当前订阅源新建一个 skill" onClick={openCreate}>
                ＋ 新建
              </button>
            ) : null}
          </span>
        </div>
        <div className="list">
          {data?.skills?.length
            ? data.skills.map((s) => renderRow(s))
            : <div className="row muted">（订阅源里暂无 skill；点上方＋订阅一个 skill 目录）</div>}
        </div>
      </div>

      <div className="card">
        <div className="colhead">
          <h3>
            <button
              className="disclose"
              title="未入 Hub 是次要信息，默认收起；展开后按平台目录分组"
              onClick={() => patchUi({ orphansOpen: !orphansOpen })}
            >
              <span className="caret">{orphansOpen ? '▾' : '▸'}</span> 未入 Hub
            </button>
            <span className="muted">
              {' '}{orphanCount} 个{orphanCount ? `（项目 ${orphanProjCount} · 用户 ${orphanUserCount}）` : ''}
              {orphansOpen ? ' —— 提交后收敛为「唯一实文件 = 订阅源」' : ''}
            </span>
          </h3>
        </div>
        <div className="list" hidden={!orphansOpen}>
          {orphanGroups.length ? (
            orphanGroups.map((g) => (
              <Fragment key={g.key}>
                <div className="colhead" style={{ padding: '0 12px' }}>
                  <h3 style={{ fontSize: 12, fontWeight: 600 }}>
                    <button className="disclose" title="展开 / 收起这一组" onClick={() => toggleGroup(g)}>
                      <span className="caret">{isGroupOpen(g) ? '▾' : '▸'}</span> {g.label}
                    </button>
                    <span className="muted" style={{ fontWeight: 400 }}>  {g.items.length} 个</span>
                  </h3>
                  <Copyable
                    className="muted"
                    text={[...g.dirs].join('\n')}
                    title="点击复制这一组涉及的平台目录"
                  >
                    {[...g.dirs][0]}{g.dirs.size > 1 ? ` 等 ${g.dirs.size} 个目录` : ''}
                  </Copyable>
                </div>
                {isGroupOpen(g) ? g.items.map((o) => renderRow(o, { orphan: true })) : null}
              </Fragment>
            ))
          ) : (
            <div className="row muted">（没有游离的 skill）</div>
          )}
        </div>
      </div>


      <CliHints module="skills" />

      {modal ? <Modal title={modal.title} onClose={() => setModal(null)}>{modal.node}</Modal> : null}
      {dialogNode}
    </>
  );
}
