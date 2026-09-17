// 环境变量页：能力横幅 / 变量表 / PATH 条目编辑 / 快照。
//
// 所有写入都走同一条流程：**先 dry-run 拿 diff → 弹窗给你看 → 确认才落盘**。
// 这不是 UI 偏好，而是本页唯一涉及「改坏整台机器 PATH」的地方——
// 让用户先看见将要发生什么，再决定。
//
// 每个按钮 = 一条 HTTP 路由 = 一条 CLI 命令（同源于 ../env/index.js 的 action 声明）。
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { useToast, useGuard, useDialog, Modal, DiffPre, Copyable } from '../../web/frontend/components/ui.jsx';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';

const truncate = (v, n = 72) => (v.length > n ? v.slice(0, n - 1) + '…' : v);

function ScopePills({ value, onChange, writable }) {
  return (
    <span className="plats">
      {['user', 'system'].map((s) => {
        const disabled = s === 'system' && !writable;
        return (
          <button
            key={s}
            type="button"
            className={'pill' + (value === s ? ' on' : '')}
            disabled={disabled}
            title={disabled ? '需要以管理员身份运行 nx-rh' : undefined}
            onClick={() => !disabled && onChange(s)}
          >
            {s === 'user' ? '用户级' : '系统级'}
          </button>
        );
      })}
    </span>
  );
}

export default function EnvView() {
  const toast = useToast();
  const guard = useGuard();
  const { dialog, node: dialogNode } = useDialog();

  const [status, setStatus] = useState(null);
  const [list, setList] = useState(null);
  const [snapshots, setSnapshots] = useState([]);
  const [pending, setPending] = useState(null); // { title, diff, apply }
  const [busy, setBusy] = useState(false);

  // 查询表单
  const [q, setQ] = useState('');
  const [addDir, setAddDir] = useState('');
  const [addScope, setAddScope] = useState('user');
  const [edit, setEdit] = useState(null); // { name, scope, value, kind }

  const load = useCallback(async () => {
    const [st, ls, snaps] = await Promise.all([
      api('/api/env/status'),
      api('/api/env').catch(() => null),
      api('/api/env/snapshots').catch(() => []),
    ]);
    setStatus(st);
    setList(ls);
    setSnapshots(snaps);
  }, []);

  useEffect(() => { load().catch((e) => toast(String(e.message || e))); }, [load, toast]);

  const supported = status?.supported === true;
  const sysWritable = status?.scopeWritable?.system === true;

  // ─── 写入统一入口：dry-run 预览 → 确认 → 落盘 ───────────────────────

  const propose = (title, path, method, body) => guard(async () => {
    setBusy(true);
    try {
      const dry = await api(path, { method, body: { ...body, 'dry-run': true } });
      if (dry.status === 'skipped') { toast('已跳过：' + dry.reason); return; }
      setPending({
        title,
        diff: dry.diff,
        apply: async () => {
          const out = await api(path, { method, body: { ...body, 'dry-run': false } });
          await load();
          return out;
        },
      });
    } finally {
      setBusy(false);
    }
  });

  const confirmPending = () => guard(async () => {
    const p = pending;
    setPending(null);
    setBusy(true);
    try {
      await p.apply();
      toast('已写入（写入前已自动快照，可用快照回滚）');
    } finally {
      setBusy(false);
    }
  });

  // ─── 各操作 ─────────────────────────────────────────────────────────

  const setVar = (name, scope, value, kind) =>
    propose(`写入 ${name}（${scope === 'user' ? '用户级' : '系统级'}）`,
      `/api/env/${encodeURIComponent(name)}`, 'PUT', { value, scope, kind });

  const delVar = (name, scope) =>
    propose(`删除 ${name}（${scope === 'user' ? '用户级' : '系统级'}）`,
      `/api/env/${encodeURIComponent(name)}`, 'DELETE', { scope });

  const addPath = () => {
    const dir = addDir.trim();
    if (!dir) { toast('请输入要加入 PATH 的目录'); return; }
    propose(`把目录加入 PATH（${addScope === 'user' ? '用户级' : '系统级'}）`,
      '/api/env/path', 'POST', { dir, scope: addScope });
  };

  const delPath = (dir, scope) =>
    propose(`从 PATH 移除（${scope === 'user' ? '用户级' : '系统级'}）`,
      '/api/env/path', 'DELETE', { dir, scope });

  const saveSnapshot = () => guard(async () => {
    const label = await dialog({ title: '保存快照', input: true, placeholder: '备注（可留空）', okText: '保存' });
    if (label === null) return;
    await api('/api/env/snapshots', { method: 'POST', body: { label: label || undefined } });
    await load();
    toast('快照已保存');
  });

  const restoreSnapshot = (id) => guard(async () => {
    const ok = await dialog({
      title: '恢复快照',
      message: `将把两个 scope 恢复成 ${id} 的状态。\n当前多出来的变量会被删除。\n\n（恢复前会自动再存一份，所以恢复本身可被恢复）`,
      danger: true,
      okText: '下一步',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const dry = await api(`/api/env/snapshots/${encodeURIComponent(id)}/restore`, { method: 'POST', body: { 'dry-run': true } });
      setPending({
        title: `恢复快照 ${id}`,
        diff: dry.diff,
        apply: async () => {
          const out = await api(`/api/env/snapshots/${encodeURIComponent(id)}/restore`, { method: 'POST', body: { 'dry-run': false } });
          await load();
          return out;
        },
      });
    } finally {
      setBusy(false);
    }
  });

  // ─── 渲染 ───────────────────────────────────────────────────────────

  if (status && !supported) {
    return (
      <div className="card">
        <div className="colhead"><h3>环境变量</h3></div>
        <div className="dlg-msg">
          本模块目前只支持 Windows（当前平台 {status.platform}）。
          macOS / Linux 的实现位已预留，但语义差异大（launchctl / shell rc），
          留待单独实现，以免做出「看似支持实则不生效」的假实现。
        </div>
        <CliHints module="env" />
      </div>
    );
  }

  const merged = (list?.merged || []).filter(
    (m) => !q.trim() || m.name.toLowerCase().includes(q.trim().toLowerCase())
  );

  return (
    <div className="settings">
      {/* 能力横幅：进页面就知道系统级能不能写，而不是点了才报错 */}
      <div className="card">
        <div className="colhead">
          <h3>环境变量</h3>
          <span className="muted">
            {status === null ? '正在探测…'
              : status.elevated ? '已提权 · 两个 scope 均可写'
                : '未提权 · 系统级只读'}
          </span>
        </div>
        {status ? (
          <>
            <div className="meta">
              <span>用户级 <span className={status.scopeWritable.user ? '' : 'bad'}>{status.scopeWritable.user ? '可写' : '不可写'}</span></span>
              <span className="sep">·</span>
              <span>系统级 <span className={sysWritable ? '' : 'bad'}>{sysWritable ? '可写' : '只读（需管理员）'}</span></span>
              <span className="sep">·</span>
              <span className="muted">快照 <Copyable text={status.snapshotDir} /></span>
            </div>
            <div className="muted" style={{ marginTop: 6 }}>{status.note}</div>
          </>
        ) : null}
        <CliHints module="env" />
      </div>

      {/* 变量表 */}
      <div className="card">
        <div className="colhead">
          <h3>变量（{merged.length}）</h3>
          <input
            style={{ maxWidth: 220 }}
            placeholder="过滤名称…"
            value={q}
            spellCheck="false"
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div className="muted" style={{ marginBottom: 8 }}>
          标记 <b>*</b> = 用户级遮蔽了系统级（两边值不同，新进程看到的是用户级）；{' '}
          <b>+</b> = PATH 是两 scope <b>拼接</b>（不是遮蔽，见下方）；{' '}
          <b>=</b> = 两边都有且值相同。
        </div>
        {!merged.length ? <div className="muted">（无匹配）</div> : (
          <div className="list">
            {merged.map((m) => {
              const shown = m.user || m.system;
              const target = m.user ? 'user' : 'system';
              return (
                <div className="row" key={m.name}>
                  <div className="name">
                    {m.shadow ? <span className="bad" title="用户级遮蔽了系统级">* </span>
                      : m.concat ? <span className="muted" title="PATH 是拼接不是遮蔽">+ </span>
                        : m.duplicate ? <span className="muted" title="两边都有且值相同">= </span> : null}
                    <Copyable text={m.name} />
                  </div>
                  <div className="desc">
                    <span className="tag">{target === 'user' ? '用户' : '系统'}</span>{' '}
                    <span className="muted">{shown.kind === 'ExpandString' ? 'expand' : 'string'}</span>{' '}
                    <Copyable text={shown.value}>{truncate(shown.value)}</Copyable>
                  </div>
                  <div className="acts">
                    <button className="btn small ghost" disabled={busy}
                      onClick={() => setEdit({ name: m.name, scope: target, value: shown.value, kind: shown.kind })}>
                      编辑
                    </button>
                    <button className="btn small ghost" disabled={busy}
                      onClick={() => delVar(m.name, target)}>
                      删除
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 新增 / 覆盖变量 */}
      <div className="card">
        <div className="colhead">
          <h3>新增 / 覆盖变量</h3>
          <button className="btn small ghost" disabled={busy || !supported}
            onClick={() => setEdit({ name: '', scope: 'user', value: '', kind: 'String' })}>
            填写…
          </button>
        </div>
        <div className="muted">
          已存在的变量会保留它原本的大小写与类型——ExpandString 不会被降级成 String，
          否则值里的 %VAR% 会停止展开（PATH 写坏多半出在这里）。
        </div>
      </div>

      {/* PATH */}
      <div className="card">
        <div className="colhead">
          <h3>PATH</h3>
          <span className="muted">按条目增删，不用手拼字符串</span>
        </div>
        <div className="muted" style={{ marginBottom: 8 }}>
          新会话生效的 PATH = <b>系统级条目在前，用户级条目在后</b>（不是覆盖）。
          {(list?.path || []).length ? ` 共 ${list.path.length} 条。` : ''}
        </div>
        <div className="list">
          {(list?.path || []).map((p, i) => (
            <div className="row" key={`${p.scope}-${i}`}>
              <div className="name muted" style={{ minWidth: 34 }}>{String(i + 1).padStart(3)}</div>
              <div className="desc">
                <span className="tag">{p.scope === 'user' ? '用户' : '系统'}</span>{' '}
                <Copyable text={p.path} />
                {p.duplicate ? <span className="muted"> （重复）</span> : null}
              </div>
              <div className="acts">
                <button className="btn small ghost"
                  disabled={busy || (p.scope === 'system' && !sysWritable)}
                  title={p.scope === 'system' && !sysWritable ? '需要以管理员身份运行 nx-rh' : undefined}
                  onClick={() => delPath(p.path, p.scope)}>
                  移除
                </button>
              </div>
            </div>
          ))}
          {!(list?.path || []).length ? <div className="muted">（PATH 为空）</div> : null}
        </div>
        <div className="row-inline">
          <input placeholder="要加入 PATH 的目录，如 C:\\tools\\bin" value={addDir} spellCheck="false"
            onChange={(e) => setAddDir(e.target.value)} />
          <ScopePills value={addScope} onChange={setAddScope} writable={sysWritable} />
          <button className="btn" disabled={busy || !supported} onClick={addPath}>追加</button>
        </div>
      </div>

      {/* 快照 */}
      <div className="card">
        <div className="colhead">
          <h3>快照（{snapshots.length}）</h3>
          <button className="btn small ghost" disabled={busy || !supported} onClick={saveSnapshot}>存一份</button>
        </div>
        <div className="muted" style={{ marginBottom: 8 }}>
          每次写入前都会自动生成一份，保留最近 50 份。恢复前也会自动备份，所以恢复本身可被恢复。
        </div>
        {!snapshots.length ? <div className="muted">（还没有快照）</div> : (
          <div className="list">
            {snapshots.slice(0, 20).map((s) => (
              <div className="row" key={s.id}>
                <div className="name mono"><Copyable text={s.id} /></div>
                <div className="desc">
                  <span className="muted">{s.createdAt}</span> · 用户 {s.userCount} / 系统 {s.systemCount}
                  {s.reason ? <> · <span className="muted">{s.reason}</span></> : null}
                </div>
                <div className="acts">
                  <button className="btn small ghost" disabled={busy || !supported}
                    onClick={() => restoreSnapshot(s.id)}>恢复</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 编辑变量弹窗 */}
      {edit ? (
        <Modal title={edit.name ? `编辑 ${edit.name}` : '新增变量'} onClose={() => setEdit(null)}>
          <div className="row-inline">
            <input placeholder="名称" value={edit.name} spellCheck="false" autoFocus={!edit.name}
              onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
          </div>
          <div className="row-inline">
            <input placeholder="值" value={edit.value} spellCheck="false" autoFocus={!!edit.name}
              onChange={(e) => setEdit({ ...edit, value: e.target.value })} />
          </div>
          <div className="row-inline" style={{ alignItems: 'center' }}>
            <ScopePills value={edit.scope} onChange={(s) => setEdit({ ...edit, scope: s })} writable={sysWritable} />
            <button
              type="button"
              className={'pill' + (edit.kind === 'ExpandString' ? ' on' : '')}
              title="值里的 %VAR% 会被展开（Windows 对 PATH 的惯例）"
              onClick={() => setEdit({ ...edit, kind: edit.kind === 'ExpandString' ? 'String' : 'ExpandString' })}
            >
              expand
            </button>
            <button className="btn" disabled={busy || !edit.name.trim()}
              onClick={() => { const e = edit; setEdit(null); setVar(e.name.trim(), e.scope, e.value, e.kind); }}>
              预览改动
            </button>
          </div>
          <div className="muted" style={{ marginTop: 8 }}>
            点「预览改动」不会立刻写入——先给你看 diff，确认后才落盘。
          </div>
        </Modal>
      ) : null}

      {/* dry-run 确认弹窗：所有写入的唯一出口 */}
      {pending ? (
        <Modal title={pending.title} onClose={() => setPending(null)}>
          <div className="muted" style={{ marginBottom: 8 }}>
            以下改动<b>尚未落盘</b>。确认后会先自动快照再写入。
          </div>
          <DiffPre text={pending.diff} />
          <div className="row-inline">
            <button className="btn ghost" onClick={() => setPending(null)}>取消</button>
            <button className="btn" disabled={busy} onClick={confirmPending}>确认写入</button>
          </div>
        </Modal>
      ) : null}

      {dialogNode}
    </div>
  );
}
