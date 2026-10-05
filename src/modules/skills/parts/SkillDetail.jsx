// ③ Skill 详情页：安装状态矩阵 + 双形态操作集（在订阅源=迁移/编辑/删除，
// 不在订阅源=收进订阅源/删除），文件预览折叠在最后。
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../web/frontend/api/client.js';
import { useStore } from '../../../web/frontend/store.jsx';
import { useToast, useGuard, useDialog, Copyable } from '../../../web/frontend/components/ui.jsx';
import { Crumbs, SCOPE_SHORT, shortLabel } from './shared.jsx';
import { SubmitIntoDialog } from './dialogs.jsx';
import { goOverview } from './routes.js';

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

export function SkillDetail({ name, tick }) {
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
      toast(r.removed?.length ? (cell.linkType ? `已撤销 ${SCOPE_SHORT[cell.scope]}·${cell.platform}` : `已删除 ${SCOPE_SHORT[cell.scope]}·${cell.platform} 的实体副本`) : '该目标本就没有');
    } else {
      const r = await api('/api/skills/migrate', { method: 'POST', body: { ...base, mode: settings.skillSyncMode } });
      if (r.status === 'blocked') { toast('跨源冲突，先解决订阅'); await load(); return; }
      toast(`已迁移到 ${SCOPE_SHORT[cell.scope]}·${cell.platform}`);
    }
    await load();
  });

  // 单格按实体副本迁移（绕过全局「迁移形态」设置）：方便在平台之间互拷、
  // 或想要一份不随 Hub 变动的独立副本。
  const migrateCellCopy = (cell) => guard(async () => {
    const r = await api('/api/skills/migrate', { method: 'POST', body: { name, to: cell.scope, platform: cell.platform, mode: 'copy' } });
    if (r.status === 'blocked') { toast('跨源冲突，先解决订阅'); await load(); return; }
    toast(`已复制实体到 ${SCOPE_SHORT[cell.scope]}·${cell.platform}`);
    await load();
  });

  // 链接 → 实体副本（物化）：断开与订阅源的实时同步，之后这里的内容独立演进。
  const materializeCell = (cell) => guard(async () => {
    const ok = await dialog({
      message: `把 ${SCOPE_SHORT[cell.scope]}·${cell.platformName} 的链接转成实体副本？\n之后这里的内容不再随订阅源变化（撤销需删掉重迁）。`,
      okText: '转实体',
    });
    if (!ok) return;
    const r = await api('/api/skills/materialize', { method: 'POST', body: { name, to: cell.scope, platform: cell.platform } });
    toast(r.converted ? '已转为实体副本' : '（这里本就是实体）');
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
                    {c.on
                      ? <>
                          {/* 链接行：撤销 = 摘掉指针，Hub 真相不受影响；实体行：删除 = 连本地改动一起删，语义不同，按钮分开 */}
                          {!c.linkType ? <button className="btn small ghost" title="转成实体副本，不再随订阅源变化" onClick={() => materializeCell(c)}>转实体</button> : null}
                          <button
                            className="btn small ghost"
                            title={c.linkType ? '撤销安装（订阅源不受影响）' : '删除这份实体副本——可能含本地改动，删除后不可恢复（Hub 里那份仍在）'}
                            onClick={() => toggleCell(c)}
                          >
                            {c.linkType ? '撤销' : '删除'}
                          </button>
                        </>
                      : <>
                          <button className={'btn small'} onClick={() => toggleCell(c)}>迁移</button>
                          <button className="btn small ghost" title="以实体副本安装（独立一份，不随订阅源变化）" onClick={() => migrateCellCopy(c)}>实体</button>
                        </>}
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
