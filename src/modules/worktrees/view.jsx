// 工作树页：工作树清单 + 主项目上下文 + 扩展文件登记/发现/同步。
// 每个按钮 = 一条 HTTP 路由 = 一条 CLI 命令（同源于模块 action 声明）。
// 录入类动作收进弹窗，主页面保持干净；移动端表格转卡片。
import { useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { useStore } from '../../web/frontend/store.jsx';
import { useGuard, useDialog, Copyable, Modal } from '../../web/frontend/components/ui.jsx';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';

const sh = (h) => String(h || '').slice(0, 8);

// ---- 结果文本（与 index.js 的人读渲染保持同形） ----

function rebaseText(r) {
  if (r.status === 'ok') return `已 rebase 到 ${r.base}\n${r.path}`;
  if (r.status === 'conflict')
    return `冲突，已自动 abort\n${r.path} -> ${r.base}\n\n${r.output || ''}`;
  return `未执行\n${r.path || ''}\n${r.reason || ''}`;
}

function fanoutText(r) {
  if (r.status === 'ok')
    return `完成 ${r.completed.length} 个 -> ${r.base}\n` + r.completed.map((x) => '  ' + x).join('\n');
  if (r.status === 'conflict')
    return `冲突于「${r.failedAt}」，已 abort；已完成 ${r.completed.join(', ') || '无'}\n\n${r.output || ''}`;
  if (r.status === 'blocked')
    return `被阻止（基础 ${r.base}）\n` + r.plan.map((p) => `  ${p.name}: ${p.blockers.join('; ')}`).join('\n');
  return '';
}

function syncText(r) {
  const s = r.summary;
  return (
    `同步到 ${r.target}（${r.mode}）\n` +
    `复制 ${s.copied}，链接 ${s.linked}，跳过 ${s.skipped}，冲突 ${s.conflict}，缺失 ${s.missing}，错误 ${s.error}\n\n` +
    r.results.map((x) => `  ${x.action.padEnd(9)} ${x.rel}${x.detail ? '  ' + x.detail : ''}`).join('\n')
  );
}

// ---- 小组件 ----

function WtTags({ w }) {
  return (
    <>
      {w.isMain ? <span className="tag strong">主</span> : null}
      {w.dirty ? <span className="tag strong">改动</span> : null}
      {w.detached ? <span className="tag">分离</span> : null}
      {w.ahead ? <span className="tag">↑{w.ahead}</span> : null}
      {w.behind ? <span className="tag">↓{w.behind}</span> : null}
      {w.extMissing ? <span className="tag strong">缺扩展{w.extMissing}</span> : null}
    </>
  );
}

function ExtState({ item, isMain }) {
  if (!item.present) return <span className="tag strong">缺失</span>;
  if (isMain) return item.changed ? <span className="tag strong">变更</span> : <span className="tag">一致</span>;
  return item.upToDate ? <span className="tag">一致</span> : <span className="tag strong">差异</span>;
}

export default function WorktreesView() {
  const { boot, refreshBoot } = useStore();
  const guard = useGuard();
  const { dialog, node: dialogNode } = useDialog();
  const [modal, setModal] = useState(null);

  const data = boot?.worktrees || { git: false };
  const cfg = data.config || {};
  const worktrees = data.worktrees || [];
  const extItems = data.extItems || [];
  const extIsMain = data.extTarget ? extIsMainEval(data) : true;

  function extIsMainEval(d) {
    const t = String(d.extTarget || '').replace(/\\/g, '/').toLowerCase();
    const m = String(d.main || '').replace(/\\/g, '/').toLowerCase();
    return t === m;
  }

  // ---- 工作树动作 ----

  const openContext = () =>
    guard(async () => {
      const r = await api('/api/wt/context');
      setModal({ kind: 'context', payload: r });
    });

  const openFanout = () =>
    guard(async () => {
      const r = await api('/api/wt/fanout', { method: 'POST', body: {} });
      setModal({ kind: 'fanout', payload: r });
    });

  const runFanout = () =>
    guard(async () => {
      const r = await api('/api/wt/fanout', { method: 'POST', body: { yes: true } });
      setModal({ kind: 'result', payload: { title: 'Fanout 结果', text: fanoutText(r) } });
      await refreshBoot();
    });

  const doRebase = (w) =>
    guard(async () => {
      const ok = await dialog({
        title: `Rebase 工作树「${w.name}」`,
        message: `把分支 ${w.branch} rebase 到主项目当前分支。\n有未提交改动会被阻止（脏树可用 CLI：nx-rh wt rebase ${w.name} --message "WIP"）。`,
        okText: 'Rebase',
      });
      if (!ok) return;
      const r = await api('/api/wt/rebase', { method: 'POST', body: { ref: w.name } });
      setModal({ kind: 'result', payload: { title: 'Rebase 结果', text: rebaseText(r) } });
      await refreshBoot();
    });

  const doOpen = (w) =>
    guard(async () => {
      await api('/api/wt/open', { method: 'POST', body: { ref: w.name } });
    });

  const doRemove = (w) =>
    guard(async () => {
      const ok = await dialog({
        title: `移除工作树「${w.name}」`,
        danger: true,
        message: `移除工作树\n${w.path}\n\n分支默认保留（连分支删：nx-rh wt remove ${w.name} --branch）。`,
        okText: '移除',
      });
      if (!ok) return;
      const r = await api(`/api/wt/${encodeURIComponent(w.name)}`, { method: 'DELETE' });
      if (r.status === 'blocked')
        setModal({ kind: 'result', payload: { title: '未移除', text: r.reason } });
      await refreshBoot();
    });

  const submitNew = (e) =>
    guard(async () => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      const description = String(f.get('description') || '').trim();
      if (!description) return;
      const r = await api('/api/wt', {
        method: 'POST',
        body: {
          description,
          name: String(f.get('name') || '').trim() || undefined,
          base: String(f.get('base') || '').trim() || undefined,
          root: String(f.get('root') || '').trim() || undefined,
        },
      });
      setModal({ kind: 'result', payload: { title: '工作树已创建', text: `cd "${r.path}"`, copy: true } });
      await refreshBoot();
    });

  // ---- 扩展文件动作 ----

  const submitExtAdd = (e) =>
    guard(async () => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      const abspath = String(f.get('abspath') || '').trim();
      if (!abspath) return;
      await api('/api/wt/ext', {
        method: 'POST',
        body: { abspath, label: String(f.get('label') || '').trim() || undefined },
      });
      setModal(null);
      await refreshBoot();
    });

  const openDiscover = () =>
    guard(async () => {
      const r = await api('/api/wt/ext/discover', { method: 'POST', body: {} });
      setModal({ kind: 'discover', payload: r });
    });

  const applyDiscover = () =>
    guard(async () => {
      const r = await api('/api/wt/ext/discover', { method: 'POST', body: { apply: true } });
      setModal({
        kind: 'result',
        payload: {
          title: '扩展文件已登记',
          text: `新登记 ${r.summary.added} 个\n` + r.added.map((x) => '  + ' + x.relPath).join('\n'),
        },
      });
      await refreshBoot();
    });

  const doExtRemove = (it) =>
    guard(async () => {
      const ok = await dialog({
        title: '移除扩展文件登记',
        danger: true,
        message: `移除「${it.rel}」的登记？\n磁盘文件不会被删除。`,
      });
      if (!ok) return;
      await api(`/api/wt/ext/${encodeURIComponent(it.id)}`, { method: 'DELETE' });
      await refreshBoot();
    });

  const doSync = (extra = {}) =>
    guard(async () => {
      const body = { ...extra };
      const r = await api('/api/wt/ext/sync', { method: 'POST', body });
      setModal({ kind: 'sync', payload: { ...r, req: body } });
      await refreshBoot();
    });

  // ---- 配置 ----

  const submitConfig = (e) =>
    guard(async () => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      await api('/api/wt/config', {
        method: 'PATCH',
        body: {
          branchPrefix: String(f.get('branchPrefix') || ''),
          baseBranch: String(f.get('baseBranch') || ''),
          worktreeRoot: String(f.get('worktreeRoot') || ''),
          syncMode: String(f.get('syncMode') || 'copy'),
        },
      });
      setModal(null);
      await refreshBoot();
    });

  const head = (
    <div className="page-head">
      <div className="title-block">
        <h2>工作树</h2>
        <div className="page-desc">
          用 git worktree 为每件事开一个独立工作目录：分支互不干扰，共享同一个仓库。
          被 .gitignore 忽略、不会自动带进工作树的文件，登记为扩展文件后一键同步。
        </div>
      </div>
      <div className="acts">
        <button className="btn ghost" onClick={openContext} disabled={!data.git}>主项目上下文</button>
        <button className="btn ghost" onClick={openFanout} disabled={!data.git}>Fanout</button>
        <button className="btn ghost" onClick={() => setModal({ kind: 'config' })} disabled={!data.git}>配置</button>
        <button className="btn" onClick={() => setModal({ kind: 'new' })} disabled={!data.git}>新建工作树</button>
      </div>
    </div>
  );

  if (!data.git) {
    return (
      <>
        {head}
        <div className="card" style={{ padding: 18 }}>
          <div className="colhead"><h3>当前目录不是 git 仓库</h3></div>
          <pre style={{ padding: '10px 0' }}>{data.project}</pre>
          <div className="muted">
            用右上角的项目下拉切到一个 git 项目，或先执行 git init。
            {data.error ? <div>诊断信息: {data.error}</div> : null}
          </div>
        </div>
        {dialogNode}
      </>
    );
  }

  return (
    <>
      {head}

      {/* 主仓库信息条 */}
      <div className="card" style={{ padding: 14 }}>
        <div className="muted" style={{ fontSize: 11, marginBottom: 5 }}>主仓库（点击复制）</div>
        <Copyable text={data.main} className="nm">{data.main}</Copyable>
        {data.currentWorktree ? (
          <div className="muted" style={{ marginTop: 6, fontSize: 11 }}>
            当前在工作树: <Copyable text={data.currentWorktree}>{data.currentWorktree}</Copyable>
          </div>
        ) : null}
        <div className="muted" style={{ marginTop: 8, fontSize: 11, lineHeight: 1.7 }}>
          分支前缀 {cfg.branchPrefix} · 基础分支 {cfg.baseBranch} · 同步方式 {cfg.syncMode}
          <br />
          工作树根 {cfg.worktreeRoot}
        </div>
      </div>

      {/* 工作树清单 */}
      <div className="card">
        <table className="card-table">
          <thead><tr>
            <th style={{ width: 220 }}>分支 / 名称</th>
            <th style={{ width: 170 }}>状态</th>
            <th>路径</th>
            <th style={{ width: 260 }}>操作</th>
          </tr></thead>
          <tbody>
            {worktrees.length ? worktrees.map((w) => (
              <tr key={w.path}>
                <td className="cell-name" data-label="分支/名称">
                  <span className="nm">{w.branch || '(detached)'}</span>
                  <div className="sub-desc">{w.name} · {sh(w.head)}</div>
                </td>
                <td data-label="状态"><WtTags w={w} /></td>
                <td className="cell-path" data-label="路径">
                  <Copyable text={w.path}>{w.path}</Copyable>
                </td>
                <td className="ops" data-label="操作">
                  <Copyable className="btn small ghost" text={`cd "${w.path}"`}>cd</Copyable>
                  <button className="btn small ghost" onClick={() => doOpen(w)}>打开</button>
                  {!w.isMain ? (
                    <>
                      <button className="btn small ghost" title="把扩展文件同步进这个工作树"
                        onClick={() => doSync({ target: w.name })}>同步扩展</button>
                      <button className="btn small ghost" onClick={() => doRebase(w)}>rebase</button>
                      <button className="btn small ghost" onClick={() => doRemove(w)}>删除</button>
                    </>
                  ) : null}
                </td>
              </tr>
            )) : <tr><td colSpan={4} className="muted">（暂无工作树，点右上角「新建工作树」）</td></tr>}
          </tbody>
        </table>
      </div>

      {/* 扩展文件 */}
      <div className="card">
        <div className="colhead">
          <h3>扩展文件</h3>
          <span className="muted" style={{ marginLeft: 8 }}>
            评估目标: {data.extTarget}（{extIsMain ? '主仓库' : '工作树'}）
          </span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button className="btn small ghost" onClick={openDiscover}>发现</button>
            <button className="btn small ghost" onClick={() => setModal({ kind: 'extAdd' })}>登记</button>
            <button className="btn small" onClick={() => doSync({})}>同步到当前树</button>
          </span>
        </div>
        <table className="card-table">
          <thead><tr>
            <th>路径（相对主仓库）</th>
            <th style={{ width: 90 }}>状态</th>
            <th style={{ width: 170 }}>标签 / 修改时间</th>
            <th style={{ width: 80 }}>操作</th>
          </tr></thead>
          <tbody>
            {extItems.length ? extItems.map((it) => (
              <tr key={it.id}>
                <td className="cell-name" data-label="路径">
                  <span className="nm">{it.rel}</span>
                  {it.outside ? <div className="sub-desc">主仓库外（不可按相对路径同步）</div> : null}
                </td>
                <td data-label="状态"><ExtState item={it} isMain={extIsMain} /></td>
                <td className="muted" data-label="标签/时间" style={{ fontSize: 11 }}>
                  {it.label || ''}
                  <br />
                  {it.mtime ? it.mtime.slice(0, 16).replace('T', ' ') : '-'}
                </td>
                <td className="ops" data-label="操作">
                  <button className="btn small ghost" onClick={() => doExtRemove(it)}>删除</button>
                </td>
              </tr>
            )) : (
              <tr><td colSpan={4} className="muted">
                （暂无扩展文件；点「发现」从 .gitignore 识别，或「登记」按全路径添加）
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      <CliHints module="worktrees" />

      {/* 新建工作树 */}
      {modal?.kind === 'new' ? (
        <Modal title="新建工作树" onClose={() => setModal(null)}>
          <form className="form-grid" onSubmit={submitNew}>
            <div className="form-field">
              <label htmlFor="wt-desc">你要做什么 *</label>
              <input id="wt-desc" name="description" placeholder="如：给登录页加图形验证码" spellCheck="false" autoFocus />
              <span className="hint">自动生成分支 {cfg.branchPrefix}{'<会话名>'}</span>
            </div>
            <div className="form-field">
              <label htmlFor="wt-name">会话名（可选）</label>
              <input id="wt-name" name="name" placeholder="留空则由描述生成" spellCheck="false" />
            </div>
            <div className="form-field">
              <label htmlFor="wt-base">起点分支（可选）</label>
              <input id="wt-base" name="base" placeholder={`留空＝${cfg.baseBranch}`} spellCheck="false" />
            </div>
            <div className="form-field">
              <label htmlFor="wt-root">工作树根（可选）</label>
              <input id="wt-root" name="root" placeholder={`留空＝${cfg.worktreeRoot}`} spellCheck="false" />
            </div>
            <div className="form-acts">
              <button type="button" className="btn ghost" onClick={() => setModal(null)}>取消</button>
              <button type="submit" className="btn">创建</button>
            </div>
          </form>
        </Modal>
      ) : null}

      {/* 配置 */}
      {modal?.kind === 'config' ? (
        <Modal title="工作树配置" onClose={() => setModal(null)}>
          <form className="form-grid" onSubmit={submitConfig}>
            <div className="form-field">
              <label htmlFor="cfg-prefix">分支前缀</label>
              <input id="cfg-prefix" name="branchPrefix" defaultValue={cfg.branchPrefix} spellCheck="false" />
            </div>
            <div className="form-field">
              <label htmlFor="cfg-base">基础分支</label>
              <input id="cfg-base" name="baseBranch" defaultValue={cfg.baseBranch} spellCheck="false" />
            </div>
            <div className="form-field">
              <label htmlFor="cfg-root">工作树根（绝对路径；相对路径按主仓库解析）</label>
              <input id="cfg-root" name="worktreeRoot" defaultValue={cfg.worktreeRoot} spellCheck="false" />
            </div>
            <div className="form-field">
              <label htmlFor="cfg-mode">扩展文件默认同步方式</label>
              <select id="cfg-mode" name="syncMode" defaultValue={cfg.syncMode}>
                <option value="copy">copy（复制，跨平台最稳）</option>
                <option value="symlink">symlink（链接；Windows 目录用 junction）</option>
              </select>
            </div>
            <div className="form-acts">
              <button type="button" className="btn ghost" onClick={() => setModal(null)}>取消</button>
              <button type="submit" className="btn">保存</button>
            </div>
          </form>
        </Modal>
      ) : null}

      {/* 登记扩展文件 */}
      {modal?.kind === 'extAdd' ? (
        <Modal title="登记扩展文件（全路径）" onClose={() => setModal(null)}>
          <form className="form-grid" onSubmit={submitExtAdd}>
            <div className="form-field">
              <label htmlFor="ext-abs">文件/目录的绝对路径 *</label>
              <input id="ext-abs" name="abspath" placeholder="D:/proj/my-project/.env.local" spellCheck="false" autoFocus />
              <span className="hint">须被 git 忽略（.gitignore）；非忽略文件需在 CLI 加 --force</span>
            </div>
            <div className="form-field">
              <label htmlFor="ext-label">标签（可选）</label>
              <input id="ext-label" name="label" placeholder="如：本地密钥" spellCheck="false" />
            </div>
            <div className="form-acts">
              <button type="button" className="btn ghost" onClick={() => setModal(null)}>取消</button>
              <button type="submit" className="btn">登记</button>
            </div>
          </form>
        </Modal>
      ) : null}

      {/* 主项目上下文 */}
      {modal?.kind === 'context' ? (
        <ContextModal c={modal.payload} onClose={() => setModal(null)} />
      ) : null}

      {/* Fanout 计划 */}
      {modal?.kind === 'fanout' ? (
        <Modal title="Fanout 计划" onClose={() => setModal(null)}>
          <div className="muted" style={{ marginBottom: 8 }}>
            基础 {modal.payload.base}：{modal.payload.plan.length} 个目标，{modal.payload.blockedCount} 个不可执行
          </div>
          <table className="card-table">
            <thead><tr><th>分支</th><th style={{ width: 90 }}>判定</th><th>原因</th></tr></thead>
            <tbody>
              {modal.payload.plan.map((p) => (
                <tr key={p.path}>
                  <td>{p.branch}<div className="sub-desc">{p.name}</div></td>
                  <td>{p.safe ? <span className="tag">可执行</span> : <span className="tag strong">阻止</span>}</td>
                  <td className="muted">{p.blockers.join('; ') || '-'}</td>
                </tr>
              ))}
              {!modal.payload.plan.length ? (
                <tr><td colSpan={3} className="muted">没有需要同步的工作树</td></tr>
              ) : null}
            </tbody>
          </table>
          <div className="form-acts">
            <button className="btn ghost" onClick={() => setModal(null)}>关闭</button>
            <button className="btn" disabled={modal.payload.blockedCount > 0} onClick={runFanout}>全部执行</button>
          </div>
        </Modal>
      ) : null}

      {/* 发现结果 */}
      {modal?.kind === 'discover' ? (
        <Modal title="发现被忽略文件" onClose={() => setModal(null)}>
          <div className="muted" style={{ marginBottom: 8 }}>
            候选 {modal.payload.summary.found}，可登记 {modal.payload.summary.registrable}，
            已登记 {modal.payload.summary.alreadyRegistered}
          </div>
          <table className="card-table">
            <thead><tr><th>路径</th><th style={{ width: 80 }}>类型</th><th style={{ width: 90 }}>来源</th><th style={{ width: 80 }}>状态</th></tr></thead>
            <tbody>
              {modal.payload.proposals.map((p) => (
                <tr key={p.rel}>
                  <td>{p.rel}</td>
                  <td className="muted">{p.kind || '-'}</td>
                  <td className="muted">{p.source}</td>
                  <td>{p.alreadyRegistered ? <span className="tag">已登记</span>
                    : p.exists ? <span className="tag">可登记</span>
                    : <span className="tag strong">不存在</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="form-acts">
            <button className="btn ghost" onClick={() => setModal(null)}>关闭</button>
            <button className="btn" disabled={modal.payload.summary.registrable === 0} onClick={applyDiscover}>
              登记全部候选
            </button>
          </div>
        </Modal>
      ) : null}

      {/* 同步结果 */}
      {modal?.kind === 'sync' ? (
        <Modal title="同步结果" onClose={() => setModal(null)}>
          <pre>{syncText(modal.payload)}</pre>
          {modal.payload.summary.conflict ? (
            <div className="form-acts">
              <button className="btn danger" onClick={() => doSync({ ...modal.payload.req, force: true })}>
                强制覆盖重跑
              </button>
            </div>
          ) : null}
        </Modal>
      ) : null}

      {/* 通用结果 */}
      {modal?.kind === 'result' ? (
        <Modal title={modal.payload.title} onClose={() => setModal(null)}>
          <pre>{modal.payload.text}</pre>
          {modal.payload.copy ? (
            <div className="form-acts"><Copyable className="btn small" text={modal.payload.text}>复制</Copyable></div>
          ) : null}
        </Modal>
      ) : null}

      {dialogNode}
    </>
  );
}

// 主项目上下文弹窗
function ContextModal({ c, onClose }) {
  const m = c.main;
  return (
    <Modal title="主项目上下文" onClose={onClose}>
      <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>{m.path}</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        <span className="tag strong">{m.branch || 'detached'}</span>
        <span className="tag">{sh(m.head)}</span>
        {m.dirty ? <span className="tag strong">有改动</span> : <span className="tag">干净</span>}
        <span className="tag">基础 {c.baseBranch}</span>
      </div>
      <pre>{m.status}</pre>
      <pre>{m.log}</pre>

      {c.currentWorktree ? (
        <>
          <div className="muted" style={{ fontSize: 11, margin: '10px 0 4px' }}>当前工作树</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <span className="tag strong">{c.currentWorktree.branch || 'detached'}</span>
            {c.currentWorktree.dirty ? <span className="tag strong">有改动</span> : <span className="tag">干净</span>}
            <span className="tag">
              ↑{c.currentWorktree.divergence.ahead ?? '?'} ↓{c.currentWorktree.divergence.behind ?? '?'}
            </span>
          </div>
        </>
      ) : null}

      <div className="muted" style={{ fontSize: 11, margin: '12px 0 4px' }}>扩展文件</div>
      <div className="muted" style={{ fontSize: 11 }}>
        主项目：登记 {c.extensions.main.registered}，在场 {c.extensions.main.present}，
        变更 {c.extensions.main.changed}，缺失 {c.extensions.main.missing}
      </div>
      {c.extensions.here ? (
        <div className="muted" style={{ fontSize: 11 }}>
          当前树：一致 {c.extensions.here.upToDate}，差异 {c.extensions.here.differs}，
          缺失 {c.extensions.here.missing}
        </div>
      ) : null}

      {c.suggested.length ? (
        <>
          <div className="muted" style={{ fontSize: 11, margin: '12px 0 6px' }}>建议指令（点击复制）</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {c.suggested.map((s) => (
              <Copyable key={s} text={s}>{s}</Copyable>
            ))}
          </div>
        </>
      ) : null}
    </Modal>
  );
}
