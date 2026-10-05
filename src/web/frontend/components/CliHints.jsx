// CLI 等价提示：列出当前模块的全部同构命令。
// 为给列表页降噪，默认折叠成一行；需要核对命令时再展开。
// 命令来自 bootstrap 下发的命令表，与 CLI 实际注册的命令同源。
import { Fragment, useState } from 'react';
import { useStore } from '../store.jsx';
import { Copyable } from './ui.jsx';

export function CliHints({ module: moduleId }) {
  const { boot } = useStore();
  const [open, setOpen] = useState(false);
  const cmds = (boot?.commands || []).filter((c) => c.module === moduleId);
  if (!cmds.length) return null;

  return (
    <details className="cli-hint" open={open} onToggle={(e) => setOpen(e.target.open)}>
      <summary>等价 CLI 命令（{cmds.length}）</summary>
      <div className="cli-hint-body">
        {cmds.map((c, i) => (
          <Fragment key={c.id}>
            {i > 0 ? <span className="muted">·</span> : null}
            <Copyable className="cli-cmd" text={c.command} title={`点击复制：${c.usage}`}>
              {c.command}
            </Copyable>
          </Fragment>
        ))}
        <span className="muted">加 <code className="cli-hint-flag">--json</code> 得机器可读输出。</span>
      </div>
    </details>
  );
}
