// 工作树页的表单弹窗：每个弹窗自带 onSubmit 调 api，接收 {onClose, onDone}。
// onDone = 完成后的刷新回调（通常是 refreshBoot）；表单状态不外泄。
import { api } from '../../../web/frontend/api/client.js';
import { useGuard, useToast, Copyable, Modal } from '../../../web/frontend/components/ui.jsx';

export function NewWtModal({ cfg, onClose, onDone }) {
  const guard = useGuard();
  const submit = (e) =>
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
      onDone({ kind: 'result', payload: { title: '工作树已创建', text: `cd "${r.path}"`, copy: true } });
    });
  return (
    <Modal title="新建工作树" onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
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
          <button type="button" className="btn ghost" onClick={onClose}>取消</button>
          <button type="submit" className="btn">创建</button>
        </div>
      </form>
    </Modal>
  );
}

export function ConfigModal({ cfg, onClose, onDone }) {
  const guard = useGuard();
  const submit = (e) =>
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
      onDone(null);
    });
  return (
    <Modal title="工作树配置" onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
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
          <button type="button" className="btn ghost" onClick={onClose}>取消</button>
          <button type="submit" className="btn">保存</button>
        </div>
      </form>
    </Modal>
  );
}

export function ExtAddModal({ onClose, onDone }) {
  const guard = useGuard();
  const toast = useToast();
  const submit = (e) =>
    guard(async () => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      const abspath = String(f.get('abspath') || '').trim();
      if (!abspath) return;
      await api('/api/wt/ext', {
        method: 'POST',
        body: { abspath, label: String(f.get('label') || '').trim() || undefined },
      });
      toast('已登记');
      onDone(null);
    });
  return (
    <Modal title="登记扩展文件（全路径）" onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
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
          <button type="button" className="btn ghost" onClick={onClose}>取消</button>
          <button type="submit" className="btn">登记</button>
        </div>
      </form>
    </Modal>
  );
}

export function ResultModal({ payload, onClose }) {
  return (
    <Modal title={payload.title} onClose={onClose}>
      <pre>{payload.text}</pre>
      {payload.copy ? (
        <div className="form-acts"><Copyable className="btn small" text={payload.text}>复制</Copyable></div>
      ) : null}
    </Modal>
  );
}
