// 仓库页：登记 / 扫描 / 状态表 / diff·pull·push·open·删除。
// 每个按钮 = 一条 HTTP 路由 = 一条 CLI 命令（三者同源于模块的 action 声明）。
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { useStore } from '../../web/frontend/store.jsx';
import { useGuard, useDialog, Modal, DiffPre, Copyable } from '../../web/frontend/components/ui.jsx';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';

function statusCell(g) {
  if (!g) return <span className="muted">未刷新</span>;
  if (g.error) return <span className="muted">非 git 仓库</span>;
  if (g.conflicted.length) return <span className="bad">冲突 {g.conflicted.length} 文件</span>;
  if (g.clean) return <span className="muted">干净</span>;
  const bits = [];
  if (g.ahead) bits.push(`领先 ${g.ahead}`);
  if (g.behind) bits.push(`落后 ${g.behind}`);
  const changed = g.staged.length + g.modified.length;
  if (changed) bits.push(`变更 ${changed}`);
  if (g.untracked.length) bits.push(`未跟踪 ${g.untracked.length}`);
  return bits.join(' · ') || '有变更';
}

export default function ReposView() {
  const { boot, refreshBoot } = useStore();
  const guard = useGuard();
  const { dialog, node: dialogNode } = useDialog();
  const [statuses, setStatuses] = useState([]);
  const [modal, setModal] = useState(null); // { title, node }
  const [form, setForm] = useState({ path: '', name: '', desc: '', tags: '' });
  const [scan, setScan] = useState({ root: '', depth: '3' });

  const repos = boot?.repos || [];
  const refreshStatuses = useCallback(async () => {
    setStatuses(await api('/api/repos/status'));
  }, []);

  useEffect(() => { refreshStatuses(); }, [refreshStatuses]);

  const addRepo = () => guard(async () => {
    if (!form.path.trim()) return;
    await api('/api/repos', {
      method: 'POST',
      body: {
        path: form.path.trim(),
        name: form.name.trim() || undefined,
        desc: form.desc.trim() || undefined,
        tags: form.tags.trim() || undefined,
      },
    });
    setForm({ path: '', name: '', desc: '', tags: '' });
    await refreshBoot();
  });

  const doScan = () => guard(async () => {
    if (!scan.root.trim()) return;
    const r = await api('/api/repos/scan', {
      method: 'POST',
      body: { root: scan.root.trim(), depth: parseInt(scan.depth, 10) || 3 },
    });
    setModal({ title: '扫描结果', node: <DiffPre text={`发现 ${r.scanned} 个 git 仓库，新登记 ${r.added.length} 个`} /> });
    await refreshBoot();
  });

  const rowAct = (act, r) => guard(async () => {
    if (act === 'diff') {
      setModal({ title: 'diff', node: <DiffPre text={await api(`/api/repos/diff?id=${encodeURIComponent(r.id)}`)} /> });
    } else if (act === 'pull') {
      const out = await api('/api/repos/pull', { method: 'POST', body: { id: r.id } });
      let text = out.output || '(无输出)';
      if (out.conflicted?.length) {
        text += '\n\n冲突文件（CLI 逐个落地）:\n' + out.conflicted.map((f) => `  nx-rh repo resolve ${r.id} --file "${f}" --side ours|theirs`).join('\n');
      }
      setModal({ title: 'pull 结果', node: <DiffPre text={text} /> });
      await refreshStatuses();
    } else if (act === 'push') {
      // 推送失败现在会抛错（EXTERNAL），由 useGuard 统一 toast——
      // 改造前是返回 {ok:false} 并在弹窗里显示「推送失败」，可退出码仍是 0，
      // agent 拿到的是「成功」，与 README 承诺的「写操作显式报错」相矛盾。
      const out = await api('/api/repos/push', { method: 'POST', body: { id: r.id } });
      setModal({ title: 'push 结果', node: <DiffPre text={out.output || '(无输出)'} /> });
      await refreshStatuses();
    } else if (act === 'open') {
      await api('/api/repos/open', { method: 'POST', body: { id: r.id } });
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
        <input placeholder="仓库绝对路径" size="26" spellCheck="false" value={form.path}
          onChange={(e) => setForm({ ...form, path: e.target.value })} />
        <input placeholder="名称(可选)" size="8" value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input placeholder="描述(可选)" size="12" spellCheck="false" value={form.desc}
          onChange={(e) => setForm({ ...form, desc: e.target.value })} />
        <input placeholder="标签,逗号分隔" size="10" value={form.tags}
          onChange={(e) => setForm({ ...form, tags: e.target.value })} />
        <button className="btn" onClick={addRepo}>添加仓库</button>
        <span className="sep"></span>
        <input placeholder="扫描根目录" size="20" spellCheck="false" value={scan.root}
          onChange={(e) => setScan({ ...scan, root: e.target.value })} />
        <input placeholder="深度" size="3" value={scan.depth}
          onChange={(e) => setScan({ ...scan, depth: e.target.value })} />
        <button className="btn" onClick={doScan}>扫描</button>
        <button className="btn ghost" onClick={() => guard(refreshStatuses)}>刷新状态</button>
      </div>

      <div className="card">
        <table>
          <thead><tr>
            <th style={{ width: 100 }}>名称</th><th>路径</th><th style={{ width: 110 }}>标签</th>
            <th style={{ width: 84 }}>分支</th><th style={{ width: 190 }}>状态</th><th style={{ width: 260 }}>操作</th>
          </tr></thead>
          <tbody>
            {repos.length ? repos.map((r) => {
              const g = statuses.find((s) => s.id === r.id)?.git;
              return (
                <tr key={r.id}>
                  <td>
                    {r.name}
                    {r.desc ? <div className="muted" style={{ fontSize: 11 }}>{r.desc}</div> : null}
                  </td>
                  <td className="path"><Copyable text={r.path}>{r.path}</Copyable></td>
                  <td>{r.tags.map((t) => <span key={t} className="tag">{t}</span>)}</td>
                  <td className="mono"><Copyable text={g?.branch || '-'} title="点击复制分支名">{g?.branch || '-'}</Copyable></td>
                  <td>{statusCell(g)}</td>
                  <td className="ops">
                    {['diff', 'pull', 'push'].map((a) => (
                      <button key={a} className="btn small ghost" onClick={() => rowAct(a, r)}>{a}</button>
                    ))}
                    <button className="btn small ghost" onClick={() => rowAct('open', r)}>打开</button>
                    <button className="btn small ghost" onClick={() => rowAct('del', r)}>删除</button>
                  </td>
                </tr>
              );
            }) : <tr><td colSpan={6} className="muted">（暂无仓库，上方添加或扫描）</td></tr>}
          </tbody>
        </table>
      </div>
      <CliHints module="repos" />

      {modal ? <Modal title={modal.title} onClose={() => setModal(null)}>{modal.node}</Modal> : null}
      {dialogNode}
    </>
  );
}
