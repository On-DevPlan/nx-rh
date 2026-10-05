// 仓库页：登记 / 扫描 / 编辑 / 打开 / 删除。
// 每个按钮 = 一条 HTTP 路由 = 一条 CLI 命令（三者同源于模块的 action 声明）。
//
// 重构：录入与扫描这两类「偶发、字段多」的动作收进弹窗，
// 主页面只保留一张干净的列表；移动端表格转卡片。
import { useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { useStore } from '../../web/frontend/store.jsx';
import { useGuard, useDialog, Copyable, Modal } from '../../web/frontend/components/ui.jsx';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';

const EMPTY_FORM = { path: '', name: '', desc: '', tags: '', notes: '' };

export default function ReposView() {
  const { boot, refreshBoot } = useStore();
  const guard = useGuard();
  const { dialog, node: dialogNode } = useDialog();
  const [form, setForm] = useState(EMPTY_FORM);
  const [editing, setEditing] = useState(null);
  const [formOpen, setFormOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [scan, setScan] = useState({ root: '', depth: '3' });
  const [scanResult, setScanResult] = useState(null);

  const repos = boot?.repos || [];
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const resetForm = () => { setForm(EMPTY_FORM); setEditing(null); setFormOpen(false); };

  const openAdd = () => {
    if (editing) { setForm(EMPTY_FORM); setEditing(null); }
    setFormOpen(true);
  };

  const submit = () => guard(async () => {
    if (!form.path.trim()) return;
    const body = {
      path: form.path.trim(),
      name: form.name.trim() || undefined,
      desc: form.desc.trim() || undefined,
      tags: form.tags.trim() || undefined,
      notes: form.notes,
    };
    if (editing) await api(`/api/repos/${encodeURIComponent(editing)}`, { method: 'PATCH', body });
    else await api('/api/repos', { method: 'POST', body });
    resetForm();
    await refreshBoot();
  });

  const startEdit = (r) => {
    setEditing(r.id);
    setForm({
      path: r.path,
      name: r.name || '',
      desc: r.desc || '',
      tags: (r.tags || []).join(','),
      notes: r.notes || '',
    });
    setFormOpen(true);
  };

  // 扫描两种意图：只发现（零副作用）/ 扫描登记（真登记）。
  const doScan = (dryRun) => guard(async () => {
    const root = scan.root.trim() || boot?.projectRoot || '';
    if (!root) return;
    const r = await api('/api/repos/scan', {
      method: 'POST',
      body: { root, depth: parseInt(scan.depth, 10) || 3, 'dry-run': dryRun },
    });
    const lines = (r.found || []).map((x) => `  ${x.known ? '已登记' : '未登记'}  ${x.path}`);
    if (dryRun) {
      setScanResult(`发现 ${r.root} 下 ${r.scanned} 个 git 仓库（未登记，磁盘与登记表都没动）`
        + (lines.length ? '\n\n' + lines.join('\n') : '\n')
        + (r.scanned ? '\n\n要收进来：点「扫描登记」，或逐个 nx-rh repo add <path> --desc "一句话描述"' : ''));
    } else {
      setScanResult(`扫描 ${r.root}: 发现 ${r.scanned} 个仓库，新登记 ${r.added.length} 个`
        + (r.added.length ? '\n\n' + r.added.map((x) => `  + ${x.name}  ${x.path}`).join('\n') : ''));
    }
    setScanOpen(false);
    await refreshBoot();
  });

  const rowAct = (act, r) => guard(async () => {
    if (act === 'open') {
      await api('/api/repos/open', { method: 'POST', body: { id: r.id } });
    } else if (act === 'edit') {
      startEdit(r);
    } else if (act === 'del') {
      const ok = await dialog({
        message: `删除仓库登记「${r.name}」？（仅移除登记，磁盘文件不受影响）`,
        danger: true,
      });
      if (!ok) return;
      await api(`/api/repos/${encodeURIComponent(r.id)}`, { method: 'DELETE' });
      await refreshBoot();
    }
  });

  return (
    <>
      <div className="page-head">
        <div className="title-block">
          <h2>仓库</h2>
          <div className="page-desc">
            登记本机的 git 仓库：它们在哪、是干什么的。面板不做分支 / 提交等 Git 操作——那些请用 IDE 或命令行。
          </div>
        </div>
        <div className="acts">
          <button className="btn ghost" onClick={() => setScanOpen(true)}>扫描</button>
          <button className="btn" onClick={openAdd}>{editing ? '继续编辑' : '添加仓库'}</button>
        </div>
      </div>

      {editing ? (
        <div className="muted" style={{ margin: '0 0 10px' }}>
          正在编辑「{repos.find((r) => r.id === editing)?.name || editing}」——点右上角「继续编辑」改完保存。
        </div>
      ) : null}

      {scanResult ? (
        <div className="card">
          <div className="colhead"><h3>扫描结果</h3>
            <span className="muted" style={{ marginLeft: 'auto' }}>
              <button className="btn small ghost" onClick={() => setScanResult(null)}>关闭</button>
            </span>
          </div>
          <pre style={{ padding: 12 }}>{scanResult}</pre>
        </div>
      ) : null}

      <div className="card">
        <table className="card-table">
          <thead><tr>
            <th style={{ width: 180 }}>名称</th><th>路径</th><th style={{ width: 130 }}>标签</th>
            <th style={{ width: 130 }}>登记 / 更新</th><th style={{ width: 176 }}>操作</th>
          </tr></thead>
          <tbody>
            {repos.length ? repos.map((r) => (
              <tr key={r.id}>
                <td className="cell-name" data-label="名称">
                  <span className="nm">{r.name}</span>
                  {r.desc ? <div className="sub-desc">{r.desc}</div> : null}
                </td>
                <td className="cell-path" data-label="路径">
                  <Copyable text={r.path}>{r.path}</Copyable>
                  {r.notes ? <div className="sub-notes">{r.notes}</div> : null}
                </td>
                <td data-label="标签">{r.tags.map((t) => <span key={t} className="tag">{t}</span>)}</td>
                <td className="muted" data-label="登记/更新" style={{ fontSize: 11 }}>
                  {(r.addedAt || '').slice(0, 10)}
                  <br />
                  {(r.updatedAt || '').slice(0, 10)}
                </td>
                <td className="ops" data-label="操作">
                  <button className="btn small ghost" onClick={() => rowAct('open', r)}>打开</button>
                  <button className="btn small ghost" onClick={() => rowAct('edit', r)}>编辑</button>
                  <button className="btn small ghost" onClick={() => rowAct('del', r)}>删除</button>
                </td>
              </tr>
            )) : <tr><td colSpan={5} className="muted">（暂无仓库，点右上角添加或扫描）</td></tr>}
          </tbody>
        </table>
      </div>
      <CliHints module="repos" />

      {/* 添加 / 编辑弹窗 */}
      {formOpen ? (
        <Modal title={editing ? `编辑仓库 · ${editing}` : '添加仓库'} onClose={resetForm}>
          <div className="form-grid">
            <div className="form-field">
              <label htmlFor="repo-path">仓库绝对路径 *</label>
              <input id="repo-path" placeholder="D:/code/my-project" spellCheck="false" value={form.path} onChange={set('path')} />
            </div>
            <div className="form-field">
              <label htmlFor="repo-name">名称</label>
              <input id="repo-name" placeholder="留空则用目录末段" value={form.name} onChange={set('name')} />
            </div>
            <div className="form-field">
              <label htmlFor="repo-desc">一句话描述</label>
              <input id="repo-desc" spellCheck="false" placeholder="这个仓库是干什么的" value={form.desc} onChange={set('desc')} />
            </div>
            <div className="form-field">
              <label htmlFor="repo-tags">标签</label>
              <input id="repo-tags" placeholder="逗号分隔，如 web,tool" value={form.tags} onChange={set('tags')} />
            </div>
            <div className="form-field">
              <label htmlFor="repo-notes">备注</label>
              <textarea id="repo-notes" placeholder="补充信息（可选）" value={form.notes} onChange={set('notes')} />
            </div>
            <div className="form-acts">
              <button className="btn ghost" onClick={resetForm}>取消</button>
              <button className="btn" disabled={!form.path.trim()} onClick={submit}>
                {editing ? '保存修改' : '添加仓库'}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}

      {/* 扫描弹窗 */}
      {scanOpen ? (
        <Modal title="扫描目录下的 git 仓库" onClose={() => setScanOpen(false)}>
          <div className="form-grid">
            <div className="form-field">
              <label htmlFor="scan-root">扫描根目录</label>
              <input id="scan-root" placeholder="留空＝当前项目目录" spellCheck="false" value={scan.root}
                onChange={(e) => setScan({ ...scan, root: e.target.value })} />
            </div>
            <div className="form-field">
              <label htmlFor="scan-depth">深度</label>
              <input id="scan-depth" value={scan.depth}
                onChange={(e) => setScan({ ...scan, depth: e.target.value })} />
            </div>
            <div className="form-acts">
              <button className="btn ghost" onClick={() => setScanOpen(false)}>取消</button>
              <button className="btn ghost" title="只列出发现的 git 仓库，不登记" onClick={() => doScan(true)}>只发现</button>
              <button className="btn" onClick={() => doScan(false)}>扫描登记</button>
            </div>
          </div>
        </Modal>
      ) : null}

      {dialogNode}
    </>
  );
}
