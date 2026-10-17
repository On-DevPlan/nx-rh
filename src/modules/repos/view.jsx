// 仓库页：登记 / 扫描 / 编辑 / 打开 / 删除 + 看板（主题容器）编排。
// 每个按钮 = 一条 HTTP 路由 = 一条 CLI 命令（三者同源于模块的 action 声明）。
//
// 版面（plan/02）：看板纵向堆叠，仓库以「手机 app 式」方格卡片呈现——
// 顶部主题容器（看板头 + 卡片网格），未分组固定最后；卡片可拖拽入板 /
// 插到某卡前 / 拖回未分组。录入与扫描收在弹窗，主页面只留编排。
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { useStore } from '../../web/frontend/store.jsx';
import { useGuard, useDialog, useToast, Modal } from '../../web/frontend/components/ui.jsx';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';

const EMPTY_FORM = { path: '', name: '', desc: '', tags: '', notes: '' };

// 手机 app 式方格卡片：首字圆角块 + 名称 + 两行描述；hover 浮出操作。
// 拖拽语义：拖到看板空白 = 追加末尾；拖到某张卡上 = 插到它前面。
function RepoCard({ r, dragId, dropHint, setDropHint, onDropCard, acts }) {
  const dragging = dragId === r.id;
  const drop = dropHint === 'card:' + r.id;
  return (
    <div
      className={'bd-card' + (drop ? ' drop' : '') + (dragging ? ' dragging' : '')}
      draggable
      title={r.path}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', r.id);
        setDropHint('');
        acts.dragStart(r.id);
      }}
      onDragEnd={() => acts.dragEnd()}
      onDragOver={(e) => {
        if (!dragId || dragId === r.id) return;
        e.preventDefault();
        e.stopPropagation();
        setDropHint('card:' + r.id);
      }}
      onDrop={(e) => {
        e.stopPropagation();
        onDropCard(r.id);
      }}
    >
      <span className="glyph">{(r.name[0] || '·').toUpperCase()}</span>
      <span className="nm">{r.name}</span>
      <span className="ds">{r.desc || '\u00a0'}</span>
      <span className="acts" onClick={(e) => e.stopPropagation()}>
        <button className="btn small ghost" title="在文件管理器中打开" onClick={() => acts.open(r)}>打开</button>
        <button className="btn small ghost" onClick={() => acts.edit(r)}>编辑</button>
        <button className="btn small ghost" onClick={() => acts.del(r)}>删除</button>
      </span>
    </div>
  );
}

// 主题容器：看板头（名称 / 描述 / 计数 / 操作）+ 卡片网格；空板提示拖入
function BoardSection({ id, name, desc, cards, renamable, dragId, dropHint, setDropHint, onDropSection, acts, onRename, onRemove }) {
  const key = id || 'unassigned';
  const drop = dropHint === key;
  return (
    <div
      className={'bd-board card' + (drop ? ' drop' : '')}
      onDragOver={(e) => {
        if (!dragId) return;
        e.preventDefault();
        setDropHint(key);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget)) return;
        setDropHint((k) => (k === key ? '' : k));
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDropSection(id);
      }}
      data-testid={'bd-board-' + key}
    >
      <div className="colhead bd-head">
        <h3>{name}</h3>
        {desc ? <span className="muted">{desc}</span> : null}
        <span className="muted bd-count">{cards.length} 个仓库</span>
        {renamable ? (
          <span className="acts">
            <button className="btn small ghost" onClick={() => onRename()}>重命名</button>
            <button className="btn small ghost" onClick={onRemove}>删除看板</button>
          </span>
        ) : null}
      </div>
      <div className="bd-grid">
        {cards.map((r) => (
          <RepoCard
            key={r.id}
            r={r}
            dragId={dragId}
            dropHint={dropHint}
            setDropHint={setDropHint}
            onDropCard={(beforeId) => acts.drop(id, beforeId)}
            acts={acts}
          />
        ))}
        {!cards.length ? (
          <div className="bd-empty muted">{id ? '空看板——把仓库卡片拖进来' : '（没有未分组仓库）'}</div>
        ) : null}
      </div>
    </div>
  );
}

export default function ReposView() {
  const { boot, refreshBoot } = useStore();
  const guard = useGuard();
  const toast = useToast();
  const { dialog, node: dialogNode } = useDialog();
  const [form, setForm] = useState(EMPTY_FORM);
  const [editing, setEditing] = useState(null);
  const [formOpen, setFormOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [scan, setScan] = useState({ root: '', depth: '3' });
  const [scanResult, setScanResult] = useState(null);

  // 看板编排
  const [boards, setBoards] = useState(null); // { boards, unassigned }
  const [dragId, setDragId] = useState('');
  const [dropHint, setDropHint] = useState('');
  const [boardForm, setBoardForm] = useState(null); // null | { id?, name, desc }
  const [impOpen, setImpOpen] = useState(false);
  const [impText, setImpText] = useState('');
  const [expText, setExpText] = useState(null);

  const repos = boot?.repos || [];
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const resetForm = () => { setForm(EMPTY_FORM); setEditing(null); setFormOpen(false); };

  const loadBoards = useCallback(async () => {
    setBoards(await api('/api/boards').catch(() => null));
  }, []);
  useEffect(() => { loadBoards(); }, [loadBoards]);

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
    await Promise.all([refreshBoot(), loadBoards()]);
  });

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
    await Promise.all([refreshBoot(), loadBoards()]);
  });

  const rowAct = (act, r) => guard(async () => {
    if (act === 'open') {
      await api('/api/repos/open', { method: 'POST', body: { id: r.id } });
    } else if (act === 'edit') {
      setEditing(r.id);
      setForm({
        path: r.path,
        name: r.name || '',
        desc: r.desc || '',
        tags: (r.tags || []).join(','),
        notes: r.notes || '',
      });
      setFormOpen(true);
    } else if (act === 'del') {
      const ok = await dialog({
        message: `删除仓库登记「${r.name}」？（仅移除登记，磁盘文件不受影响；看板里同步摘除）`,
        danger: true,
      });
      if (!ok) return;
      await api(`/api/repos/${encodeURIComponent(r.id)}`, { method: 'DELETE' });
      await Promise.all([refreshBoot(), loadBoards()]);
    }
  });

  // ---- 看板编排 ----
  const saveBoard = () => guard(async () => {
    const body = { name: boardForm.name.trim(), desc: boardForm.desc.trim() };
    if (!body.name) return;
    if (boardForm.id) await api(`/api/boards/${encodeURIComponent(boardForm.id)}`, { method: 'PATCH', body });
    else await api('/api/boards', { method: 'POST', body });
    setBoardForm(null);
    await loadBoards();
  });

  const removeBoard = (b) => guard(async () => {
    const ok = await dialog({
      message: `删看板「${b.name}」？里面的 ${b.repos.length} 个仓库回到未分组（登记不动）。`,
      danger: true,
    });
    if (!ok) return;
    await api(`/api/boards/${encodeURIComponent(b.id)}`, { method: 'DELETE', body: {} });
    await loadBoards();
  });

  // 卡片拖放：boardId 为空 = 未分组；beforeId = 插到该卡片之前
  const dropCard = (boardId, beforeId) => guard(async () => {
    const id = dragId;
    setDragId('');
    setDropHint('');
    if (!id || id === beforeId) return;
    await api('/api/boards/assign', { method: 'POST', body: { id, board: boardId || '', before: beforeId || undefined } });
    await loadBoards();
  });

  const doImport = () => guard(async () => {
    if (!impText.trim()) return;
    const r = await api('/api/boards/import', { method: 'POST', body: { json: impText } });
    setImpOpen(false);
    setImpText('');
    toast(`已导入：新建 ${r.created} 个看板、合并 ${r.merged} 个、匹配仓库 ${r.matched} 个`
      + (r.unmatched.length ? `；未匹配 ${r.unmatched.length} 条（见 CLI board import 输出）` : ''));
    await loadBoards();
  });

  const doExport = () => guard(async () => {
    const r = await api('/api/boards/export');
    setExpText(JSON.stringify(r, null, 2));
  });

  const readImpFile = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setImpText(await f.text());
  };

  if (boards === null) {
    return (
      <>
        <div className="muted" style={{ padding: 20 }}>读取中…</div>
        {dialogNode}
      </>
    );
  }

  // 卡片与拖放的公共行为包（RepoCard / BoardSection 共用）
  const cardActs = {
    open: (r) => rowAct('open', r),
    edit: (r) => rowAct('edit', r),
    del: (r) => rowAct('del', r),
    dragStart: (id) => setDragId(id),
    dragEnd: () => { setDragId(''); setDropHint(''); },
    drop: (boardId, beforeId) => dropCard(boardId, beforeId),
  };

  return (
    <>
      <div className="page-head">
        <div className="title-block">
          <h2>仓库</h2>
          <div className="page-desc">
            登记本机的 git 仓库，按看板（主题）编排：一个看板 = 一个主题，仓库卡片可拖拽归组。
          </div>
        </div>
        <div className="acts">
          <button className="btn ghost" onClick={() => setScanOpen(true)}>扫描</button>
          <button className="btn ghost" onClick={() => setBoardForm({ id: null, name: '', desc: '' })}>新建看板</button>
          <button className="btn ghost" title="粘贴/选择看板 JSON，一个看板 = 一个主题" onClick={() => setImpOpen(true)}>导入看板</button>
          <button className="btn ghost" onClick={doExport}>导出</button>
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

      {/* 看板工作台：主题容器纵向堆叠，未分组固定最后 */}
      <div className="bd-workbench" data-testid="bd-workbench">
        {(boards.boards || []).map((b) => (
          <BoardSection
            key={b.id}
            id={b.id}
            name={b.name}
            desc={b.desc}
            cards={b.repos}
            renamable
            dragId={dragId}
            dropHint={dropHint}
            setDropHint={setDropHint}
            onDropSection={(bid) => dropCard(bid, null)}
            acts={cardActs}
            onRename={() => setBoardForm({ id: b.id, name: b.name, desc: b.desc })}
            onRemove={() => removeBoard(b)}
          />
        ))}
        <BoardSection
          id=""
          name="未分组"
          desc="不在任何看板里的仓库"
          cards={boards.unassigned || []}
          renamable={false}
          dragId={dragId}
          dropHint={dropHint}
          setDropHint={setDropHint}
          onDropSection={(bid) => dropCard(bid, null)}
          acts={cardActs}
        />
      </div>
      <CliHints module="repos" />

      {/* 添加 / 编辑仓库弹窗 */}
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

      {/* 新建 / 重命名看板弹窗 */}
      {boardForm ? (
        <Modal title={boardForm.id ? '重命名看板' : '新建看板'} onClose={() => setBoardForm(null)}>
          <div className="form-grid">
            <div className="form-field">
              <label htmlFor="bd-name">主题名称 *</label>
              <input
                id="bd-name"
                placeholder="如 前端 / AI 工具"
                value={boardForm.name}
                onChange={(e) => setBoardForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="form-field">
              <label htmlFor="bd-desc">描述</label>
              <input
                id="bd-desc"
                placeholder="这个主题是干什么的（可选）"
                value={boardForm.desc}
                onChange={(e) => setBoardForm((f) => ({ ...f, desc: e.target.value }))}
              />
            </div>
            <div className="form-acts">
              <button className="btn ghost" onClick={() => setBoardForm(null)}>取消</button>
              <button className="btn" disabled={!boardForm.name.trim()} onClick={saveBoard}>
                {boardForm.id ? '保存' : '新建看板'}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}

      {/* 导入看板弹窗 */}
      {impOpen ? (
        <Modal title="导入看板 JSON" onClose={() => { setImpOpen(false); setImpText(''); }}>
          <div className="form-grid">
            <div className="form-field">
              <label htmlFor="bd-imp">JSON 内容（{'{boards:[{name, repos:[{path|name}]}]}'}</label>
              <input
                id="bd-imp-file"
                type="file"
                accept=".json,application/json"
                onChange={readImpFile}
              />
              <textarea
                id="bd-imp"
                rows={10}
                spellCheck="false"
                placeholder='{"boards":[{"name":"前端","repos":[{"path":"D:/code/a_js/proj/nx-ft"}]}]}'
                value={impText}
                onChange={(e) => setImpText(e.target.value)}
              />
            </div>
            <div className="form-acts">
              <button className="btn ghost" onClick={() => { setImpOpen(false); setImpText(''); }}>取消</button>
              <button className="btn" disabled={!impText.trim()} onClick={doImport}>导入</button>
            </div>
          </div>
        </Modal>
      ) : null}

      {/* 导出结果弹窗 */}
      {expText !== null ? (
        <Modal title="看板导出（JSON，可回灌给导入）" onClose={() => setExpText(null)}>
          <textarea className="bd-exp" rows={14} readOnly value={expText} spellCheck="false" />
          <div className="form-acts">
            <button className="btn ghost" onClick={() => setExpText(null)}>关闭</button>
            <button
              className="btn"
              onClick={() => guard(async () => {
                try { await navigator.clipboard.writeText(expText); toast('已复制到剪贴板'); }
                catch { toast('复制失败，请手动选择文本'); }
              })}
            >
              复制 JSON
            </button>
          </div>
        </Modal>
      ) : null}

      {dialogNode}
    </>
  );
}
