// 环境变量页：四象限看板 + 快照。
//
// 信息架构是一张 2×2 看板，四象限各自独立、互不混杂：
//   ┌ 用户环境变量（HKCU\Environment，非 PATH） ─ 用户 PATH 条目 ┐
//   └ 系统环境变量（HKLM\...\Environment，非 PATH） ─ 系统 PATH 条目 ┘
// 用户级可写；系统级默认只读（需管理员）。PATH 是「拼接」不是覆盖，单独成列。
//
// 所有写入都走同一条流程：**先 dry-run 拿 diff → 弹窗给你看 → 确认才落盘**。
// 这是本页唯一可能「改坏整台机器 / PATH」的地方——让用户先看见将要发生什么。
//
// 每个按钮 = 一条 HTTP 路由 = 一条 CLI 命令（同源于 ../env/index.js 的 action 声明）。
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { useToast, useGuard, useDialog, Modal, DiffPre, Copyable } from '../../web/frontend/components/ui.jsx';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';

const SCOPE_LABEL = { user: '用户级', system: '系统级' };
const EXPAND_HINT =
  '展开（REG_EXPAND_SZ）：值里的 %USERPROFILE% 这类引用会被解析；'
  + '对已有的变量不会降级成 String，否则 %VAR% 会停止展开（PATH 写坏多半出在这里）。';

const kindLabel = (k) => (k === 'ExpandString' ? 'expand' : 'string');
const truncate = (v, n = 56) => (String(v).length > n ? String(v).slice(0, n - 1) + '…' : String(v));
const isPathName = (n) => String(n).toLowerCase() === 'path';

function localTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString('zh-CN', { hour12: false });
}

// 象限外壳：标题 + 右侧状态标签 + 可滚动主体。
function Quadrant({ title, tag, children }) {
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div className="colhead">
        <h3 style={{ fontSize: 14 }}>{title}</h3>
        {tag}
      </div>
      {children}
    </div>
  );
}

// 变量象限（用户 / 系统，非 PATH）：每行 名称 + 值 + 编辑 / 删除，底部「新增」。
function VarQuadrant({ scope, values, shadowMap, writable, busy, onEdit, onDelete, onAdd }) {
  return (
    <>
      <div className="list" style={{ maxHeight: 280, overflow: 'auto' }}>
        {values.length ? values.map((v) => {
          const lower = v.name.toLowerCase();
          const sh = shadowMap.get(lower);
          const canWrite = scope === 'user' || writable;
          return (
            <div className="row" key={v.name} title={`[${kindLabel(v.kind)}] ${v.value}`}>
              <span className="name"><Copyable text={v.name} /></span>
              <Copyable className="desc mono" text={v.value}>{truncate(v.value)}</Copyable>
              {sh?.shadow
                ? <span className="tag strong" title={scope === 'user' ? '用户级覆盖了系统级' : '系统级被用户级覆盖'}>覆盖</span>
                : sh?.duplicate ? <span className="tag" title="两个 scope 都有且值相同">相同</span> : null}
              <span className="acts">
                <button className="btn small ghost" disabled={busy || !canWrite} title={canWrite ? '编辑' : '需要管理员身份'} onClick={() => onEdit(v)}>编辑</button>
                <button className="btn small ghost" disabled={busy || !canWrite} title={canWrite ? '删除' : '需要管理员身份'} onClick={() => onDelete(v)}>删除</button>
              </span>
            </div>
          );
        }) : <div className="row muted">（{SCOPE_LABEL[scope]}没有变量）</div>}
      </div>
      <div className="row-inline" style={{ padding: 8 }}>
        <button className="btn small" disabled={busy || (scope === 'system' && !writable)} onClick={onAdd}>＋ 新增变量</button>
      </div>
    </>
  );
}

// PATH 象限（用户 / 系统）：每行 序号 + 目录 + 移除，底部「追加目录」。
function PathQuadrant({ scope, entries, writable, busy, onRemove, onAdd, onAddText, addText }) {
  const canWrite = scope === 'user' || writable;
  return (
    <>
      <div className="list" style={{ maxHeight: 280, overflow: 'auto' }}>
        {entries.length ? entries.map((p, i) => (
          <div className="row" key={scope + i} title={p.path}>
            <span className="mono muted" style={{ width: 32, textAlign: 'right' }}>{String(i + 1).padStart(2)}</span>
            <Copyable className="desc mono" text={p.path}>{truncate(p.path)}</Copyable>
            {p.duplicate ? <span className="tag" title="与另一条目重复">重复</span> : null}
            <span className="acts">
              <button className="btn small ghost" disabled={busy || !canWrite} title={canWrite ? '从 PATH 移除' : '需要管理员身份'} onClick={() => onRemove(p.path)}>移除</button>
            </span>
          </div>
        )) : <div className="row muted">（{SCOPE_LABEL[scope]} PATH 为空）</div>}
      </div>
      <div className="row-inline" style={{ padding: 8, gap: 6 }}>
        <input
          className="grow"
          placeholder="要追加的目录，如 C:\\tools\\bin"
          value={addText}
          spellCheck="false"
          onChange={(e) => onAddText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && canWrite) onAdd(); }}
        />
        <button className="btn small" disabled={busy || !canWrite} onClick={onAdd}>追加</button>
      </div>
    </>
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

  // 视图状态
  const [q, setQ] = useState('');
  const [snapOpen, setSnapOpen] = useState(false); // 快照是次要区块，默认收起
  const [edit, setEdit] = useState(null); // { name, scope, value, kind, isNew }
  const [pathAdd, setPathAdd] = useState({ user: '', system: '' });

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

  // ─── 变量增删改 ─────────────────────────────────────────────────────

  const setVar = (name, scope, value, kind) =>
    propose(`写入 ${name}（${SCOPE_LABEL[scope]}）`,
      `/api/env/${encodeURIComponent(name)}`, 'PUT', { value, scope, kind });

  const delVar = (v, scope) =>
    propose(`删除 ${v.name}（${SCOPE_LABEL[scope]}）`,
      `/api/env/${encodeURIComponent(v.name)}`, 'DELETE', { scope });

  const openEdit = (scope, v) => setEdit(v
    ? { name: v.name, scope, value: v.value, kind: v.kind, isNew: false }
    : { name: '', scope, value: '', kind: 'String', isNew: true });

  // ─── PATH 增删 ──────────────────────────────────────────────────────

  const addPath = (scope) => {
    const dir = pathAdd[scope].trim();
    if (!dir) { toast('请输入要加入 PATH 的目录'); return; }
    setPathAdd((s) => ({ ...s, [scope]: '' }));
    propose(`把目录加入 PATH（${SCOPE_LABEL[scope]}）`, '/api/env/path', 'POST', { dir, scope });
  };

  const delPath = (dir, scope) =>
    propose(`从 PATH 移除（${SCOPE_LABEL[scope]}）`, '/api/env/path', 'DELETE', { dir, scope });

  // ─── 快照 ───────────────────────────────────────────────────────────

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

  const kw = q.trim().toLowerCase();
  const hit = (s) => !kw || s.toLowerCase().includes(kw);

  const userVals = (list?.scopes?.user?.values || []).filter((v) => !isPathName(v.name) && hit(v.name));
  const sysVals = (list?.scopes?.system?.values || []).filter((v) => !isPathName(v.name) && hit(v.name));
  const userPath = (list?.path || []).filter((p) => p.scope === 'user' && hit(p.path));
  const sysPath = (list?.path || []).filter((p) => p.scope === 'system' && hit(p.path));

  // 遮蔽关系速查（来自 merged 分析）
  const shadowMap = new Map((list?.merged || []).map((m) => [m.name.toLowerCase(), m]));

  const editNeedsExpand = edit?.kind !== 'ExpandString' && String(edit?.value || '').includes('%');

  return (
    <div className="stack">
      <div className="page-head">
        <div className="title-block">
          <h2>环境变量</h2>
          <div className="page-desc">
            四象限看板：用户级 / 系统级变量与 PATH 分开承载。所有写入都会先给你看 diff，确认后才落盘。
          </div>
        </div>
        <div className="acts">
          <button className="btn" disabled={busy || !supported} onClick={() => openEdit('user')}>新增变量</button>
        </div>
      </div>

      {/* 状态 + 搜索一行 */}
      <div className="toolbar">
        <input
          className="search grow"
          placeholder="过滤名称 / 路径…"
          value={q}
          spellCheck="false"
          onChange={(e) => setQ(e.target.value)}
        />
        <span className="tag" title={status?.note || ''}>
          {status === null ? '正在探测…'
            : sysWritable ? '用户级 / 系统级 均可写'
              : '用户级可写 · 系统级只读（需管理员）'}
        </span>
      </div>

      {/* 四象限看板 */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Quadrant
          title={`用户环境变量 · HKCU`}
          tag={<span className="tag">{userVals.length}</span>}
        >
          <VarQuadrant
            scope="user"
            values={userVals}
            shadowMap={shadowMap}
            writable={sysWritable}
            busy={busy}
            onEdit={(v) => openEdit('user', v)}
            onDelete={(v) => delVar(v, 'user')}
            onAdd={() => openEdit('user')}
          />
        </Quadrant>

        <Quadrant
          title={`用户 PATH 列表`}
          tag={<span className="tag">{userPath.length} 条</span>}
        >
          <PathQuadrant
            scope="user"
            entries={userPath}
            writable={sysWritable}
            busy={busy}
            addText={pathAdd.user}
            onAddText={(t) => setPathAdd((s) => ({ ...s, user: t }))}
            onAdd={() => addPath('user')}
            onRemove={(d) => delPath(d, 'user')}
          />
        </Quadrant>

        <Quadrant
          title={`系统环境变量 · HKLM`}
          tag={<span className={'tag' + (sysWritable ? '' : ' bad')}>{sysVals.length}{sysWritable ? '' : ' · 只读'}</span>}
        >
          <VarQuadrant
            scope="system"
            values={sysVals}
            shadowMap={shadowMap}
            writable={sysWritable}
            busy={busy}
            onEdit={(v) => openEdit('system', v)}
            onDelete={(v) => delVar(v, 'system')}
            onAdd={() => openEdit('system')}
          />
        </Quadrant>

        <Quadrant
          title={`系统 PATH 列表`}
          tag={<span className={'tag' + (sysWritable ? '' : ' bad')}>{sysPath.length} 条{sysWritable ? '' : ' · 只读'}</span>}
        >
          <PathQuadrant
            scope="system"
            entries={sysPath}
            writable={sysWritable}
            busy={busy}
            addText={pathAdd.system}
            onAddText={(t) => setPathAdd((s) => ({ ...s, system: t }))}
            onAdd={() => addPath('system')}
            onRemove={(d) => delPath(d, 'system')}
          />
        </Quadrant>
      </div>

      <div className="muted" style={{ fontSize: 12 }}>
        两个 scope 同名时<b>用户级覆盖</b>系统级；<b>PATH 是例外</b>——新会话 PATH = 系统条目 + 用户条目（拼接）。
        写入的是注册表持久值：<b>新开的终端才生效</b>，已启动的进程不会跟变。
      </div>

      {/* 快照：安全网，默认收起 */}
      <div className="card">
        <div className="colhead">
          <button
            className="disclose"
            title="每次写入前自动生成的备份；改坏了再回来"
            onClick={() => setSnapOpen((v) => !v)}
          >
            <span className="caret">{snapOpen ? '▾' : '▸'}</span> 快照（{snapshots.length}）
          </button>
          <button className="btn small ghost" style={{ marginLeft: 'auto' }} disabled={busy || !supported} onClick={saveSnapshot}>
            存一份
          </button>
        </div>
        {snapOpen ? (
          <>
            <div className="muted vlegend">
              每次写入前自动生成，保留最近 50 份。恢复前也会自动备份，所以恢复本身可被恢复。
            </div>
            {snapshots.length ? (
              <div className="list">
                {snapshots.map((s) => (
                  <div className="row" key={s.id}>
                    <span className="name mono snpid"><Copyable text={s.id} /></span>
                    <span className="desc">
                      {localTime(s.createdAt)} · 用户 {s.userCount} / 系统 {s.systemCount}
                      {s.reason ? ` · ${s.reason}` : ''}
                    </span>
                    <span className="acts">
                      <button className="btn small ghost" disabled={busy || !supported} onClick={() => restoreSnapshot(s.id)}>
                        恢复
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            ) : <div className="row muted">（还没有快照）</div>}
          </>
        ) : null}
      </div>

      <CliHints module="env" />

      {/* 编辑变量弹窗 */}
      {edit ? (
        <Modal
          title={edit.isNew
            ? (edit.name ? `写入 ${edit.name} · ${SCOPE_LABEL[edit.scope]}` : '新增变量')
            : `编辑 ${edit.name} · ${SCOPE_LABEL[edit.scope]}`}
          onClose={() => setEdit(null)}
        >
          {edit.isNew ? (
            <div className="row-inline">
              <input
                placeholder="变量名"
                value={edit.name}
                spellCheck="false"
                autoFocus
                onChange={(e) => setEdit({ ...edit, name: e.target.value })}
              />
            </div>
          ) : null}
          <textarea
            className="dlg-input"
            rows={3}
            placeholder="值"
            value={edit.value}
            spellCheck="false"
            autoFocus={!edit.isNew}
            onChange={(e) => setEdit({ ...edit, value: e.target.value })}
          />
          <div className="row-inline" style={{ alignItems: 'center' }}>
            <span className="plats">
              {['user', 'system'].map((s) => (
                <button
                  key={s}
                  type="button"
                  className={'pill' + (edit.scope === s ? ' on' : '')}
                  disabled={s === 'system' && !sysWritable}
                  onClick={() => setEdit({ ...edit, scope: s })}
                >
                  {SCOPE_LABEL[s]}
                </button>
              ))}
            </span>
            <button
              type="button"
              className={'pill' + (edit.kind === 'ExpandString' ? ' on' : '')}
              title={EXPAND_HINT}
              onClick={() => setEdit({ ...edit, kind: edit.kind === 'ExpandString' ? 'String' : 'ExpandString' })}
            >
              expand
            </button>
            <button
              className="btn"
              disabled={busy || !edit.name.trim()}
              onClick={() => { const e = edit; setEdit(null); setVar(e.name.trim(), e.scope, e.value, e.kind); }}
            >
              预览改动
            </button>
          </div>
          <div className="muted vlegend">
            {editNeedsExpand
              ? '值里有 %：建议打开 expand，否则 %USERPROFILE% 这类引用会按字面量存进去、永不展开。'
              : EXPAND_HINT}
            {' '}点「预览改动」不会立刻写入——先给你看 diff，确认后才落盘。
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
