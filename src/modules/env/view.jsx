// 环境变量页：变量表 + 快照。
//
// 信息架构只有两块，且主次分明：
//   1. 变量表（主角）——一行 = 一个变量名，右侧是**生效值**（新进程实际读到的那个）。
//      展开后并列显示 用户级 / 系统级 两个值，各自可编辑 / 删除。
//      旧版每行只渲染 `用户级 ?? 系统级` 一个值：被用户级覆盖掉的系统级那侧，
//      界面上既看不到、也点不到（编辑/删除写死取其中一侧）——面板看起来在报
//      「这个变量的值」，其实只说了一半。这一版把两 scope 都摆出来。
//      Path 也是表里的一行，只是展开后是**逐条目**列表，而不是一坨分号串
//      （旧版 PATH 有两处表示：表里截断的巨串 + 下方独立卡片，还得靠文字互相引用）。
//   2. 快照（安全网）——默认收起。它是写给「改错了要退回去」那一刻的，不是日常要看的。
//
// 所有写入都走同一条流程：**先 dry-run 拿 diff → 弹窗给你看 → 确认才落盘**。
// 这不是 UI 偏好，而是本页唯一涉及「改坏整台机器 PATH」的地方——
// 让用户先看见将要发生什么，再决定。
//
// 每个按钮 = 一条 HTTP 路由 = 一条 CLI 命令（同源于 ../env/index.js 的 action 声明）。
import { Fragment, useCallback, useEffect, useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { useToast, useGuard, useDialog, Modal, DiffPre, Copyable } from '../../web/frontend/components/ui.jsx';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';

const SCOPE_LABEL = { user: '用户级', system: '系统级' };
const EXPAND_HINT =
  '展开（REG_EXPAND_SZ）：值里的 %USERPROFILE% 这类引用会被解析；'
  + '对已有的变量不会降级成 String，否则 %VAR% 会停止展开（PATH 写坏多半出在这里）。';

const kindLabel = (k) => (k === 'ExpandString' ? 'expand' : 'string');
const truncate = (v, n = 96) => (String(v).length > n ? String(v).slice(0, n - 1) + '…' : String(v));

function localTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString('zh-CN', { hour12: false });
}

// 行尾那一枚标签：同一个字段同时表达「在哪个 scope」与「两 scope 的关系」。
// 于是「生效值」这一列永远只承载值——列才对得齐、扫得动；
// 旧版把 `* / + / =` 三个符号压进名称前，又用三行图例教用户解码，等于先加密再解释。
function relationTag(m) {
  if (m.concat) return { text: '两 scope 拼接', title: 'Path 不是覆盖：新会话的 PATH = 系统级条目 + 用户级条目' };
  if (m.shadow) return { text: '用户级覆盖', title: '两个 scope 都有且值不同——新进程看到的是用户级的值' };
  if (m.duplicate) return { text: '两 scope 相同', title: '两个 scope 都有且值相同，改哪一侧都行' };
  if (m.user) return { text: '仅用户级', title: '只有用户级有这个变量' };
  return { text: '仅系统级', title: '只有系统级有这个变量；改动需要管理员身份' };
}

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
            {SCOPE_LABEL[s]}
          </button>
        );
      })}
    </span>
  );
}

// 展开体里的一行：**一个**作用域的值 + 它自己的 编辑 / 删除。
// 未设置的那一侧也照常列出来（带「写入…」）——否则用户会以为面板够不到那一侧。
function ScopeField({ scope, entry, writable, busy, onEdit, onDelete }) {
  const canWrite = scope === 'user' || writable;
  const lock = canWrite ? undefined : '需要以管理员身份运行 nx-rh';
  return (
    <div className="vfield">
      <span className="tag">{SCOPE_LABEL[scope]}</span>
      {entry ? (
        <>
          <span
            className="muted kind"
            title={entry.kind === 'ExpandString' ? EXPAND_HINT : 'REG_SZ：值原样保存，不做 %VAR% 展开'}
          >
            {kindLabel(entry.kind)}
          </span>
          <Copyable className="mono val" text={entry.value}>{entry.value}</Copyable>
          <span className="acts">
            <button className="btn small ghost" disabled={busy || !canWrite} title={lock} onClick={onEdit}>编辑</button>
            <button className="btn small ghost" disabled={busy || !canWrite} title={lock} onClick={onDelete}>删除</button>
          </span>
        </>
      ) : (
        <>
          <span className="muted val">（未设置）</span>
          <span className="acts">
            <button className="btn small ghost" disabled={busy || !canWrite} title={lock} onClick={onEdit}>写入…</button>
          </span>
        </>
      )}
    </div>
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
  const [onlyUser, setOnlyUser] = useState(false); // 范围：全部 / 只看用户级设过的
  const [open, setOpen] = useState(null); // 展开的变量名（小写）；同一时刻只展开一行
  const [snapOpen, setSnapOpen] = useState(false); // 快照是次要区块，默认收起
  const [addDir, setAddDir] = useState('');
  const [addScope, setAddScope] = useState('user');
  const [edit, setEdit] = useState(null); // { name, scope, value, kind, isNew }

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
    propose(`写入 ${name}（${SCOPE_LABEL[scope]}）`,
      `/api/env/${encodeURIComponent(name)}`, 'PUT', { value, scope, kind });

  const delVar = (name, scope) =>
    propose(`删除 ${name}（${SCOPE_LABEL[scope]}）`,
      `/api/env/${encodeURIComponent(name)}`, 'DELETE', { scope });

  const addPath = () => {
    const dir = addDir.trim();
    if (!dir) { toast('请输入要加入 PATH 的目录'); return; }
    propose(`把目录加入 PATH（${SCOPE_LABEL[addScope]}）`,
      '/api/env/path', 'POST', { dir, scope: addScope });
  };

  const delPath = (dir, scope) =>
    propose(`从 PATH 移除（${SCOPE_LABEL[scope]}）`,
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

  // 名称过滤 → 范围过滤 → Path 置顶。
  // Path 是唯一带专属编辑器（逐条目而不是一坨字符串）的一条，也是唯一「写坏会让整台
  // 机器命令行不可用」的一条；让它在 54 行的字母序里随机落点并不合理——固定第一行。
  const nameHit = (list?.merged || []).filter(
    (m) => !q.trim() || m.name.toLowerCase().includes(q.trim().toLowerCase())
  );
  const userHit = nameHit.filter((m) => m.user);
  const scoped = onlyUser ? userHit : nameHit;
  const merged = (() => {
    const i = scoped.findIndex((m) => m.name.toLowerCase() === 'path');
    if (i <= 0) return scoped; // -1 = 没有 Path；0 = 已经在了
    const rest = scoped.slice();
    return [rest.splice(i, 1)[0], ...rest];
  })();
  const pathEntries = list?.path || [];
  const pathSys = pathEntries.filter((p) => p.scope === 'system').length;
  const pathUser = pathEntries.length - pathSys;

  // 一行 + （展开时的）展开体。Path 只是其中一行，展开体换成了逐条目列表。
  const renderItem = (m) => {
    const key = m.name.toLowerCase();
    const isPath = key === 'path';
    const isOpen = open === key;
    const shown = m.user || m.system;
    const rel = relationTag(m);
    // 只在系统级存在、且当前进程未提权 —— 这一行此刻动不了（要动得先建用户级覆盖）。
    const readonly = !m.user && !sysWritable;
    return (
      <Fragment key={m.name}>
        <div className={'row vrow' + (isOpen ? ' open' : '') + (readonly ? ' readonly' : '')}>
          <button
            className="vcaret"
            title={isOpen ? '收起' : '展开：分别查看 / 编辑两个作用域'}
            onClick={() => setOpen(isOpen ? null : key)}
          >
            {isOpen ? '▾' : '▸'}
          </button>
          <span className="name"><Copyable text={m.name} /></span>
          <span className="desc mono">
            {isPath ? `共 ${pathEntries.length} 条（系统 ${pathSys} · 用户 ${pathUser}）` : truncate(shown.value)}
          </span>
          <span className={'tag' + (m.shadow ? ' strong' : '')} title={rel.title}>{rel.text}</span>
        </div>

        {isOpen ? (isPath ? (
          <div className="vsub">
            <div className="muted vnote">
              新会话生效的 PATH = 系统级条目在前、用户级条目在后（拼接，不是覆盖）。
            </div>
            {pathEntries.length ? pathEntries.map((p, i) => (
              <div className="vfield" key={`${p.scope}-${i}`}>
                <span className="mono idx">{String(i + 1).padStart(3)}</span>
                <span className="tag">{p.scope === 'user' ? '用户' : '系统'}</span>
                <Copyable className="mono val" text={p.path}>{p.path}</Copyable>
                {p.duplicate ? <span className="muted kind">重复</span> : null}
                <span className="acts">
                  <button
                    className="btn small ghost"
                    disabled={busy || (p.scope === 'system' && !sysWritable)}
                    title={p.scope === 'system' && !sysWritable ? '需要以管理员身份运行 nx-rh' : undefined}
                    onClick={() => delPath(p.path, p.scope)}
                  >
                    移除
                  </button>
                </span>
              </div>
            )) : <div className="muted vnote">（PATH 为空）</div>}
            <div className="row-inline vadd">
              <input
                placeholder="要加入 PATH 的目录，如 C:\tools\bin"
                value={addDir}
                spellCheck="false"
                onChange={(e) => setAddDir(e.target.value)}
              />
              <ScopePills value={addScope} onChange={setAddScope} writable={sysWritable} />
              <button className="btn small" disabled={busy || !supported} onClick={addPath}>追加</button>
            </div>
          </div>
        ) : (
          <div className="vsub">
            {['user', 'system'].map((scope) => (
              <ScopeField
                key={scope}
                scope={scope}
                entry={m[scope]}
                writable={sysWritable}
                busy={busy}
                onEdit={() => setEdit({
                  name: m.name,
                  scope,
                  value: m[scope]?.value ?? '',
                  kind: m[scope]?.kind ?? 'String',
                  isNew: !m[scope],
                })}
                onDelete={() => delVar(m.name, scope)}
              />
            ))}
          </div>
        )) : null}
      </Fragment>
    );
  };

  // 值里有 % 但类型还是 String：这条最容易写出「以为存的是变量引用、其实是一段字面量」。
  // 编辑已有的 String 变量时同样成立（kind 是显式传下去的，会盖掉 service 的自动升级）。
  const editNeedsExpand = edit?.kind !== 'ExpandString' && String(edit?.value || '').includes('%');

  return (
    <div className="stack">
      <div className="page-head">
        <div className="title-block">
          <h2>环境变量</h2>
          <div className="page-desc">
            查看与编辑用户级 / 系统级环境变量；PATH 按条目管理。所有写入都会先给你看 diff，确认后才落盘。
          </div>
        </div>
        <div className="acts">
          <button
            className="btn"
            disabled={busy || !supported}
            onClick={() => setEdit({ name: '', scope: 'user', value: '', kind: 'String', isNew: true })}
          >
            新增变量
          </button>
        </div>
      </div>

      {/* 浏览（过滤 / 范围）一行 */}
      <div className="toolbar">
        <input
          className="search grow"
          placeholder="过滤名称…"
          value={q}
          spellCheck="false"
          onChange={(e) => setQ(e.target.value)}
        />
        <span className="sep"></span>
        <span className="plats">
          <button
            type="button"
            className={'pill' + (onlyUser ? '' : ' on')}
            title="全部变量（含只在系统级存在、当前改不了的那些）"
            onClick={() => setOnlyUser(false)}
          >
            全部 {nameHit.length}
          </button>
          <button
            type="button"
            className={'pill' + (onlyUser ? ' on' : '')}
            title="只看用户级存在或设过的——系统自带的那些不在这一档"
            onClick={() => setOnlyUser(true)}
          >
            只看用户级 {userHit.length}
          </button>
        </span>
      </div>

      {/* 变量表：本页唯一的主角 */}
      <div className="card">
        <div className="colhead">
          <h3>环境变量</h3>
          <span className="tag" title={status?.note || ''}>
            {status === null ? '正在探测…'
              : sysWritable ? '用户级 / 系统级 均可写'
                : '用户级可写 · 系统级只读（需管理员）'}
          </span>
        </div>
        <div className="muted vlegend">
          两个 scope 同名时<b>用户级覆盖</b>系统级（新进程看到用户级的值）；<b>PATH 是例外</b>——它由两者拼接。
          点行首三角可展开，分别改两个 scope；灰掉的行只在系统级有，用当前身份改不了。
          写入的是注册表持久值：<b>新开的终端才生效</b>，已启动的进程不会跟变。
        </div>
        {merged.length ? (
          <div className="list">{merged.map(renderItem)}</div>
        ) : (
          <div className="row muted">
            {!list ? '正在读取…' : '（没有匹配的变量）'}
            {list && onlyUser && nameHit.length ? (
              <button
                className="btn small ghost"
                style={{ marginLeft: 8 }}
                title="范围是「只看用户级」，但名称过滤下还有别的变量命中"
                onClick={() => setOnlyUser(false)}
              >
                改为全部（{nameHit.length}）
              </button>
            ) : null}
          </div>
        )}
      </div>

      {/* 快照：安全网，不是日常操作。默认收起，表头仍给出份数与「存一份」。 */}
      <div className="card">
        <div className="colhead">
          <button
            className="disclose"
            title="每次写入前自动生成的备份；平时不需要看，改坏了再回来"
            onClick={() => setSnapOpen((v) => !v)}
          >
            <span className="caret">{snapOpen ? '▾' : '▸'}</span> 快照（{snapshots.length}）
          </button>
          <button
            className="btn small ghost"
            style={{ marginLeft: 'auto' }}
            disabled={busy || !supported}
            onClick={saveSnapshot}
          >
            存一份
          </button>
        </div>
        {snapOpen ? (
          <>
            <div className="muted vlegend">
              每次写入前都会自动生成一份，保留最近 50 份。恢复前也会自动备份，所以恢复本身可被恢复。
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
                      <button
                        className="btn small ghost"
                        disabled={busy || !supported}
                        onClick={() => restoreSnapshot(s.id)}
                      >
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
          {/* 值可能是上千字符的 PATH，单行 input 看不全 */}
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
            <ScopePills
              value={edit.scope}
              onChange={(s) => setEdit({ ...edit, scope: s })}
              writable={sysWritable}
            />
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
