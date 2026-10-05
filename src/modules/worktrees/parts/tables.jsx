// 工作树页的两张表格：工作树清单 + 扩展文件清单。行内动作经 props 传入，
// 表格本身不发请求——动作 handler 留在 view.jsx（它们要用 useDialog 确认）。
import { Copyable } from '../../../web/frontend/components/ui.jsx';
import { sh, WtTags, ExtState } from './cards.jsx';

export function WorktreeTable({ worktrees, onOpen, onSync, onRebase, onRemove }) {
  return (
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
              <button className="btn small ghost" onClick={() => onOpen(w)}>打开</button>
              {!w.isMain ? (
                <>
                  <button className="btn small ghost" title="把扩展文件同步进这个工作树"
                    onClick={() => onSync(w)}>同步扩展</button>
                  <button className="btn small ghost" onClick={() => onRebase(w)}>rebase</button>
                  <button className="btn small ghost" onClick={() => onRemove(w)}>删除</button>
                </>
              ) : null}
            </td>
          </tr>
        )) : <tr><td colSpan={4} className="muted">（暂无工作树，点右上角「新建工作树」）</td></tr>}
      </tbody>
    </table>
  );
}

export function ExtTable({ items, isMain, onRemove }) {
  return (
    <table className="card-table">
      <thead><tr>
        <th>路径（相对主仓库）</th>
        <th style={{ width: 90 }}>状态</th>
        <th style={{ width: 170 }}>标签 / 修改时间</th>
        <th style={{ width: 80 }}>操作</th>
      </tr></thead>
      <tbody>
        {items.length ? items.map((it) => (
          <tr key={it.id}>
            <td className="cell-name" data-label="路径">
              <span className="nm">{it.rel}</span>
              {it.outside ? <div className="sub-desc">主仓库外（不可按相对路径同步）</div> : null}
            </td>
            <td data-label="状态"><ExtState item={it} isMain={isMain} /></td>
            <td className="muted" data-label="标签/时间" style={{ fontSize: 11 }}>
              {it.label || ''}
              <br />
              {it.mtime ? it.mtime.slice(0, 16).replace('T', ' ') : '-'}
            </td>
            <td className="ops" data-label="操作">
              <button className="btn small ghost" onClick={() => onRemove(it)}>删除</button>
            </td>
          </tr>
        )) : (
          <tr><td colSpan={4} className="muted">
            （暂无扩展文件；点「发现」从 .gitignore 识别，或「登记」按全路径添加）
          </td></tr>
        )}
      </tbody>
    </table>
  );
}
