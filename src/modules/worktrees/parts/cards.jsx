// 工作树页的小展示件：HEAD 短码、状态 tag、扩展文件状态、评估目标判定。
export const sh = (h) => String(h || '').slice(0, 8);

export function WtTags({ w }) {
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

export function ExtState({ item, isMain }) {
  if (!item.present) return <span className="tag strong">缺失</span>;
  if (isMain) return item.changed ? <span className="tag strong">变更</span> : <span className="tag">一致</span>;
  return item.upToDate ? <span className="tag">一致</span> : <span className="tag strong">差异</span>;
}

// 评估目标是否主仓库：bootstrap 数据里的 extTarget 与 main 比较（大小写/斜杠归一）
export function extIsMainEval(d) {
  const t = String(d.extTarget || '').replace(/\\/g, '/').toLowerCase();
  const m = String(d.main || '').replace(/\\/g, '/').toLowerCase();
  return t === m;
}
