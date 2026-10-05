// 工作树页：工作树清单 + 主项目上下文 + 扩展文件登记/发现/同步。
// 每个按钮 = 一条 HTTP 路由 = 一条 CLI 命令（同源于模块 action 声明）。
// 录入类动作收进弹窗，主页面保持干净；移动端表格转卡片。
//
// 本文件保留：页头/信息卡/两块表格 + 从表格按钮发起的确认类动作 + 弹窗分发。
// 表格在 parts/tables.jsx，弹窗在 parts/modals.jsx 与 parts/flows.jsx。
import { useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { useStore } from '../../web/frontend/store.jsx';
import { useGuard, useDialog, Copyable } from '../../web/frontend/components/ui.jsx';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';
import { extIsMainEval } from './parts/cards.jsx';
import { WorktreeTable, ExtTable } from './parts/tables.jsx';
import { NewWtModal, ConfigModal, ExtAddModal, ResultModal } from './parts/modals.jsx';
import {
  ContextModal, FanoutModal, DiscoverModal, rebaseText, fanoutText,
} from './parts/flows.jsx';

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

  const showResult = (payload) => setModal({ kind: 'result', payload });

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
      showResult({ title: 'Fanout 结果', text: fanoutText(r) });
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
      showResult({ title: 'Rebase 结果', text: rebaseText(r) });
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
        showResult({ title: '未移除', text: r.reason });
      await refreshBoot();
    });

  // ---- 扩展文件动作 ----

  const openDiscover = () =>
    guard(async () => {
      const r = await api('/api/wt/ext/discover', { method: 'POST', body: {} });
      setModal({ kind: 'discover', payload: r });
    });

  const applyDiscover = () =>
    guard(async () => {
      const r = await api('/api/wt/ext/discover', { method: 'POST', body: { apply: true } });
      showResult({
        title: '扩展文件已登记',
        text: `新登记 ${r.summary.added} 个\n` + r.added.map((x) => '  + ' + x.relPath).join('\n'),
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

  const head = (
    <div className="page-head">
      <div className="title-block">
        <h2>工作树</h2>
        <div className="page-desc">
          用 git worktree 为每件事开一个独立工作目录：分支互不干扰，共享同一个仓库。
          本模块只做「登记 + 提醒」，不复制文件——用「主项目上下文」查看主项目变更；
          被 .gitignore 忽略的本地工具/文档登记为扩展文件（只读参考），需要内容时 agent 自行复制。
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
          分支前缀 {cfg.branchPrefix} · 基础分支 {cfg.baseBranch}
          <br />
          工作树根 {cfg.worktreeRoot}
        </div>
      </div>

      {/* 工作树清单 */}
      <div className="card">
        <WorktreeTable worktrees={worktrees} onOpen={doOpen} onRebase={doRebase} onRemove={doRemove} />
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
          </span>
        </div>
        <ExtTable items={extItems} isMain={extIsMain} onRemove={doExtRemove} />
      </div>

      <CliHints module="worktrees" />

      {/* 弹窗分发：表单类在 modals.jsx，流程类在 flows.jsx */}
      {modal?.kind === 'new' ? <NewWtModal cfg={cfg} onClose={() => setModal(null)} onDone={(next) => { setModal(next); refreshBoot(); }} /> : null}
      {modal?.kind === 'config' ? <ConfigModal cfg={cfg} onClose={() => setModal(null)} onDone={() => { setModal(null); refreshBoot(); }} /> : null}
      {modal?.kind === 'extAdd' ? <ExtAddModal onClose={() => setModal(null)} onDone={() => { setModal(null); refreshBoot(); }} /> : null}
      {modal?.kind === 'context' ? <ContextModal c={modal.payload} onClose={() => setModal(null)} /> : null}
      {modal?.kind === 'fanout' ? <FanoutModal payload={modal.payload} onClose={() => setModal(null)} onRun={runFanout} /> : null}
      {modal?.kind === 'discover' ? <DiscoverModal payload={modal.payload} onClose={() => setModal(null)} onApply={applyDiscover} /> : null}
      {modal?.kind === 'result' ? <ResultModal payload={modal.payload} onClose={() => setModal(null)} /> : null}

      {dialogNode}
    </>
  );
}
