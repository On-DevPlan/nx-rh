// 工作树页的流程弹窗：上下文 / fanout 计划 / 发现结果 / 同步结果。
// 这些弹窗读的是 view 层已经拿到的 payload；「全部执行 / 登记全部候选 / 强制覆盖」
// 经 props（onRun/onApply/onForce）回到 view 层的 handler 发请求。
import { Copyable, Modal } from '../../../web/frontend/components/ui.jsx';
import { sh } from './cards.jsx';

// ---- 结果文本（与 renders.js 的人读渲染保持同形） ----

export function rebaseText(r) {
  if (r.status === 'ok') return `已 rebase 到 ${r.base}\n${r.path}`;
  if (r.status === 'conflict')
    return `冲突，已自动 abort\n${r.path} -> ${r.base}\n\n${r.output || ''}`;
  return `未执行\n${r.path || ''}\n${r.reason || ''}`;
}

export function fanoutText(r) {
  if (r.status === 'ok')
    return `完成 ${r.completed.length} 个 -> ${r.base}\n` + r.completed.map((x) => '  ' + x).join('\n');
  if (r.status === 'conflict')
    return `冲突于「${r.failedAt}」，已 abort；已完成 ${r.completed.join(', ') || '无'}\n\n${r.output || ''}`;
  if (r.status === 'blocked')
    return `被阻止（基础 ${r.base}）\n` + r.plan.map((p) => `  ${p.name}: ${p.blockers.join('; ')}`).join('\n');
  return '';
}

export function ContextModal({ c, onClose }) {
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

      {c.attention?.length ? (
        <>
          <div className="muted" style={{ fontSize: 11, margin: '12px 0 6px' }}>
            需要关注（主项目本地工具/文档目录，被 ignore、不进工作树，只读参考）
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {c.attention.map((a) => (
              <div key={a.rel} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="tag strong">关注</span>
                <span className="nm">{a.rel}</span>
                {a.mainPath ? (
                  <span style={{ marginLeft: 'auto' }}>
                    <Copyable text={a.mainPath} className="btn small ghost">复制主项目路径</Copyable>
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </>
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

export function FanoutModal({ payload, onClose, onRun }) {
  return (
    <Modal title="Fanout 计划" onClose={onClose}>
      <div className="muted" style={{ marginBottom: 8 }}>
        基础 {payload.base}：{payload.plan.length} 个目标，{payload.blockedCount} 个不可执行
      </div>
      <table className="card-table">
        <thead><tr><th>分支</th><th style={{ width: 90 }}>判定</th><th>原因</th></tr></thead>
        <tbody>
          {payload.plan.map((p) => (
            <tr key={p.path}>
              <td>{p.branch}<div className="sub-desc">{p.name}</div></td>
              <td>{p.safe ? <span className="tag">可执行</span> : <span className="tag strong">阻止</span>}</td>
              <td className="muted">{p.blockers.join('; ') || '-'}</td>
            </tr>
          ))}
          {!payload.plan.length ? (
            <tr><td colSpan={3} className="muted">没有需要同步的工作树</td></tr>
          ) : null}
        </tbody>
      </table>
      <div className="form-acts">
        <button className="btn ghost" onClick={onClose}>关闭</button>
        <button className="btn" disabled={payload.blockedCount > 0} onClick={onRun}>全部执行</button>
      </div>
    </Modal>
  );
}

export function DiscoverModal({ payload, onClose, onApply }) {
  return (
    <Modal title="发现被忽略文件" onClose={onClose}>
      <div className="muted" style={{ marginBottom: 8 }}>
        候选 {payload.summary.found}，可登记 {payload.summary.registrable}，
        已登记 {payload.summary.alreadyRegistered}
      </div>
      <table className="card-table">
        <thead><tr><th>路径</th><th style={{ width: 80 }}>类型</th><th style={{ width: 90 }}>来源</th><th style={{ width: 80 }}>状态</th></tr></thead>
        <tbody>
          {payload.proposals.map((p) => (
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
        <button className="btn ghost" onClick={onClose}>关闭</button>
        <button className="btn" disabled={payload.summary.registrable === 0} onClick={onApply}>
          登记全部候选
        </button>
      </div>
    </Modal>
  );
}
