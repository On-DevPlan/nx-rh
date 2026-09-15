// 通用 UI 件：toast、对话框、弹窗、pill、diff 渲染。
// 约定延续自 vanilla 版：无 emoji、不用浏览器原生弹窗（alert/confirm/prompt 一律页内实现）。
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

// ---- toast：页内轻提示（自动消失） ----

const ToastCtx = createContext(null);

export function ToastProvider({ children }) {
  const [msgs, setMsgs] = useState([]);
  const idRef = useRef(0);

  const toast = useCallback((msg) => {
    const id = ++idRef.current;
    setMsgs((m) => [...m, { id, msg }]);
    setTimeout(() => setMsgs((m) => m.filter((x) => x.id !== id)), 2800);
  }, []);

  return (
    <ToastCtx.Provider value={toast}>
      {children}
      <div className="toast-stack">
        {msgs.map((m) => <div key={m.id} className="toast show">{m.msg}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx) || ((m) => console.log(m));
}

// 操作守卫：包一层，失败自动 toast 错误信息（对应 vanilla 版的 guard()）
export function useGuard() {
  const toast = useToast();
  return useCallback(async (fn) => {
    try { return await fn(); } catch (e) { toast(String((e && e.message) || e)); }
  }, [toast]);
}

// ---- 点击即复制：所有路径/长标识的展示标准 ----
// 点一下复制全文；hover 显示「点击复制」提示；复制成功 toast 确认。
export function Copyable({ text, className = '', title, children }) {
  const toast = useToast();
  const copy = async () => {
    const v = String(text ?? '');
    try {
      await navigator.clipboard.writeText(v);
      toast('已复制: ' + (v.length > 60 ? v.slice(0, 57) + '...' : v));
    } catch {
      // 剪贴板 API 不可用（非安全上下文等）：退回 execCommand
      try {
        const ta = document.createElement('textarea');
        ta.value = v;
        ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        toast('已复制: ' + (v.length > 60 ? v.slice(0, 57) + '...' : v));
      } catch {
        toast('复制失败（剪贴板不可用）');
      }
    }
  };
  return (
    <span
      className={'copyable' + (className ? ' ' + className : '')}
      title={title || '点击复制'}
      onClick={copy}
    >{children !== undefined ? children : text}</span>
  );
}

// ---- 对话框：确认 / 输入（Promise 风格，对应 vanilla 版 dialog()） ----

export function useDialog() {
  const [state, setState] = useState(null); // {resolve, ...opts}
  const close = useCallback((val) => {
    setState((s) => { if (s && s.resolve) s.resolve(val); return null; });
  }, []);

  const dialog = useCallback((opts = {}) => new Promise((resolve) => {
    setState({ ...opts, resolve });
  }), []);

  const node = state ? (
    <div className="dlg" onMouseDown={(e) => { if (e.target === e.currentTarget) close(null); }}>
      <div className="dlg-box">
        {state.title ? <div className="dlg-title">{state.title}</div> : null}
        {state.message ? <div className="dlg-msg">{state.message}</div> : null}
        {state.input ? (
          <input
            className="dlg-input"
            autoFocus
            spellCheck="false"
            placeholder={state.placeholder || ''}
            defaultValue={state.value || ''}
            onKeyDown={(e) => {
              if (e.key === 'Enter') close(e.currentTarget.value.trim());
              if (e.key === 'Escape') close(null);
            }}
          />
        ) : null}
        <div className="dlg-acts">
          <button className="btn ghost" onClick={() => close(null)}>取消</button>
          <button
            className={'btn' + (state.danger ? ' danger' : '')}
            onClick={() => {
              const inp = document.querySelector('.dlg-input');
              close(state.input ? (inp ? inp.value.trim() : null) : true);
            }}
          >
            {state.okText || '确定'}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return { dialog, node };
}

// ---- 弹窗：大块内容（diff / 冲突详情 / 命令输出） ----

export function Modal({ title, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-box">
        <div className="modal-title">
          <span>{title}</span>
          <button className="btn small ghost" onClick={onClose}>关闭</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

// ---- diff 文本渲染（+/- 行着色） ----

export function DiffPre({ text }) {
  const lines = String(text ?? '').split('\n');
  return (
    <pre>
      {lines.map((line, i) => (
        <span key={i} className={
          line.startsWith('+') && !line.startsWith('+++') ? 'd-add'
            : line.startsWith('-') && !line.startsWith('---') ? 'd-del' : ''
        }>
          {line}{i < lines.length - 1 ? '\n' : ''}
        </span>
      ))}
    </pre>
  );
}
