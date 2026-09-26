// 仓库页：登记 / 扫描 / 编辑 / 打开 / 删除。
// 每个按钮 = 一条 HTTP 路由 = 一条 CLI 命令（三者同源于模块的 action 声明）。
//
// 这里刻意没有分支 / 变更 / diff / pull / push —— 面板做 git 客户端是条没有尽头的路
// （状态刷新、冲突落地、凭据、进度、失败恢复都要自己造），体验永远不如 IDE 或
// 命令行本身。本项目只回答「有哪些仓库、在哪、是干什么的」。
import { useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { useStore } from '../../web/frontend/store.jsx';
import { useGuard, useDialog, Copyable } from '../../web/frontend/components/ui.jsx';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';

const EMPTY_FORM = { path: '', name: '', desc: '', tags: '', notes: '' };

export default function ReposView() {
  const { boot, refreshBoot } = useStore();
  const guard = useGuard();
  const { dialog, node: dialogNode } = useDialog();
  const [form, setForm] = useState(EMPTY_FORM);
  const [editing, setEditing] = useState(null); // 正在编辑的 repo id；null = 新增模式
  const [scan, setScan] = useState({ root: '', depth: '3' });
  const [scanResult, setScanResult] = useState(null);

  const repos = boot?.repos || [];
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const resetForm = () => { setForm(EMPTY_FORM); setEditing(null); };

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
  };

  const doScan = () => guard(async () => {
    if (!scan.root.trim()) return;
    const r = await api('/api/repos/scan', {
      method: 'POST',
      body: { root: scan.root.trim(), depth: parseInt(scan.depth, 10) || 3 },
    });
    setScanResult(`扫描 ${r.root}\n发现 ${r.scanned} 个仓库，新登记 ${r.added.length} 个`
      + (r.added.length ? '\n\n' + r.added.map((x) => `  + ${x.name}  ${x.path}`).join('\n') : ''));
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
      <div className="toolbar">
        <input placeholder="仓库绝对路径" size="26" spellCheck="false" value={form.path} onChange={set('path')} />
        <input placeholder="名称(可选)" size="8" value={form.name} onChange={set('name')} />
        <input placeholder="描述(可选)" size="12" spellCheck="false" value={form.desc} onChange={set('desc')} />
        <input placeholder="标签,逗号分隔" size="10" value={form.tags} onChange={set('tags')} />
        <input placeholder="备注(可选)" size="12" value={form.notes} onChange={set('notes')} />
        <button className="btn" onClick={submit}>{editing ? '保存修改' : '添加仓库'}</button>
        {editing ? <button className="btn ghost" onClick={resetForm}>取消编辑</button> : null}
        <span className="sep"></span>
        <input placeholder="扫描根目录" size="20" spellCheck="false" value={scan.root}
          onChange={(e) => setScan({ ...scan, root: e.target.value })} />
        <input placeholder="深度" size="3" value={scan.depth}
          onChange={(e) => setScan({ ...scan, depth: e.target.value })} />
        <button className="btn ghost" onClick={doScan}>扫描登记</button>
      </div>

      {editing ? (
        <div className="muted" style={{ margin: '0 0 8px' }}>
          正在编辑「{repos.find((r) => r.id === editing)?.name || editing}」——改完点「保存修改」，或点「取消编辑」回到新增模式。
        </div>
      ) : null}

      {scanResult ? (
        <div className="card">
          <div className="colhead"><h3>扫描结果</h3>
            <button className="btn small ghost" onClick={() => setScanResult(null)}>关闭</button>
          </div>
          <pre>{scanResult}</pre>
        </div>
      ) : null}

      <div className="card">
        <table>
          <thead><tr>
            <th style={{ width: 120 }}>名称</th><th>路径</th><th style={{ width: 110 }}>标签</th>
            <th style={{ width: 150 }}>登记 / 更新</th><th style={{ width: 190 }}>操作</th>
          </tr></thead>
          <tbody>
            {repos.length ? repos.map((r) => (
              <tr key={r.id}>
                <td>
                  {r.name}
                  {r.desc ? <div className="muted" style={{ fontSize: 11 }}>{r.desc}</div> : null}
                </td>
                <td className="path">
                  <Copyable text={r.path}>{r.path}</Copyable>
                  {r.notes ? <div className="muted" style={{ fontSize: 11 }}>{r.notes}</div> : null}
                </td>
                <td>{r.tags.map((t) => <span key={t} className="tag">{t}</span>)}</td>
                <td className="muted" style={{ fontSize: 11 }}>
                  {(r.addedAt || '').slice(0, 10)}
                  <br />
                  {(r.updatedAt || '').slice(0, 10)}
                </td>
                <td className="ops">
                  <button className="btn small ghost" onClick={() => rowAct('open', r)}>打开</button>
                  <button className="btn small ghost" onClick={() => rowAct('edit', r)}>编辑</button>
                  <button className="btn small ghost" onClick={() => rowAct('del', r)}>删除</button>
                </td>
              </tr>
            )) : <tr><td colSpan={5} className="muted">（暂无仓库，上方添加或扫描）</td></tr>}
          </tbody>
        </table>
      </div>
      <CliHints module="repos" />

      {dialogNode}
    </>
  );
}
