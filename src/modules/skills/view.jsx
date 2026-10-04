// Skill 页：以「订阅源（Skill Hub）」为唯一可信源，把 skill 迁移到各平台目录。
//
// 单向流：订阅源 → 目标（迁移）；目标 → 订阅源（提交）。
// 不做「项目之间互迁」——项目目录只是落地副本。
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { useStore } from '../../web/frontend/store.jsx';
import { useToast, useGuard, useDialog, Modal, Copyable } from '../../web/frontend/components/ui.jsx';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';

const SCOPE_SHORT = { user: '用户', project: '项目' };

function shortLabel(adapterId, adapters) {
  const a = adapters.find((x) => x.id === adapterId);
  return (a ? a.name : adapterId).replace(/\s*\(.*\)$/, '').split(/[\s-]/)[0].toLowerCase();
}

const pathSegs = (p) => String(p || '').replace(/\\/g, '/').split('/').filter(Boolean);
const lastSeg = (p) => pathSegs(p).slice(-1)[0] || String(p || '');

// 订阅源的展示名（与 src/modules/skills/index.js 的 sourceLabel 是同一套算法，改一处要改两处）。
//
// 单源时末段就够了。**多源时不行**：订阅源目录几乎都叫 `skills`
// （`~/.claude/skills`、`D:\a_other\md\sl\skills`），末段全都一模一样，
// 于是列表里每一行的来源标签都写着同一个词，等于没标；下拉里也变成两个「skills」。
//
// 做法：先剥掉**所有源共有**的尾部段（通常就是 `skills`），再取「最短能唯一区分」的尾部；
// 父目录也重名时继续往上退。完整路径始终留在 title 里，所以不会丢信息。
// all = 全部订阅源路径（不传就只能退回末段，也就是这里要修掉的那个行为）。
function sourceLabel(p, all) {
  if (!p) return '';
  const uniq = [...new Set([...(all || []), p].filter(Boolean))];
  if (uniq.length < 2) return lastSeg(p);

  const all2 = uniq.map(pathSegs);
  // 1) 公共尾部段不参与区分
  let common = 0;
  const minLen = Math.min(...all2.map((s) => s.length));
  while (common + 1 < minLen) {
    const i = common + 1;
    const tail = all2[0][all2[0].length - i].toLowerCase();
    if (all2.every((s) => s[s.length - i].toLowerCase() === tail)) common += 1;
    else break;
  }
  const pools = all2.map((s) => (s.length > common ? s.slice(0, s.length - common) : s));

  // 2) 最短唯一后缀（父目录同名就再往上退一级）
  const idx = uniq.indexOf(p);
  const own = pools[idx];
  let n = 1;
  while (n < own.length) {
    const tail = own.slice(-n).join('/').toLowerCase();
    if (!pools.some((o, j) => j !== idx && o.slice(-n).join('/').toLowerCase() === tail)) break;
    n += 1;
  }
  return own.slice(-n).join('/') || lastSeg(p);
}

// ---- skill 编辑器：新建 / 编辑共用（面板里的 C 与 U） ----
function SkillEditor({ mode, skill = {}, close, reload }) {
  const { toast } = useToast();
  const isEdit = mode === 'edit';
  const [name, setName] = useState(skill.name || '');
  const [description, setDescription] = useState(skill.description || '');
  const [content, setContent] = useState(skill.content || '');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (busy) return;
    setErr('');
    if (!isEdit && !name.trim()) { setErr('需要一个 skill 名（小写连字符）'); return; }
    setBusy(true);
    try {
      if (isEdit) {
        await api('/api/skills/' + encodeURIComponent(skill.name), { method: 'PATCH', body: { content } });
      } else {
        await api('/api/skills', { method: 'POST', body: { name: name.trim(), description, content } });
      }
      toast(isEdit ? '已保存' : '已创建');
      close();
      await reload();
    } catch (e) {
      setErr(String((e && e.message) || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {err ? <div className="tag bad" style={{ marginBottom: 8, whiteSpace: 'pre-wrap' }}>{err}</div> : null}
      {!isEdit ? (
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <input
            style={{ flex: 1 }}
            placeholder="skill 名（小写连字符，如 my-skill）"
            value={name}
            spellCheck="false"
            onChange={(e) => setName(e.target.value)}
          />
          <input
            style={{ flex: 2 }}
            placeholder="一句话描述（写入 frontmatter）"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
      ) : null}
      <textarea
        style={{
          width: '100%', minHeight: 320, padding: 8,
          fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12, lineHeight: 1.5,
          border: '1px solid var(--soft-2)', borderRadius: 4, background: 'var(--paper)', color: 'var(--ink)',
        }}
        spellCheck="false"
        placeholder={
          isEdit
            ? ''
            : '正文（留空则自动生成 frontmatter 与标题）。\n也可以直接给完整 SKILL.md（以 --- 开头，name 须与上面一致）。'
        }
        value={content}
        onChange={(e) => setContent(e.target.value)}
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
        <button className="btn ghost" onClick={close}>取消</button>
        <button className="btn" disabled={busy} onClick={save}>{busy ? '保存中…' : '保存'}</button>
      </div>
    </>
  );
}

// skill 文件查看器：左树右内容，SKILL.md 默认选中。
//
// 「完整查看」的落点就在这里——一个 skill 不止 SKILL.md，还常有 scripts/、references/，
// 而它们恰恰是决定「这个 skill 到底干什么」的部分。内容按需拉（点哪个读哪个），
// 目录大的 skill 也不会一次性把几百 KB 塞进弹窗。
function SkillFiles({ name, files }) {
  // 默认选 SKILL.md（大小写不敏感：Windows 上存在写成 skill.md 的 skill）
  const [cur, setCur] = useState(
    () => (files.find((f) => f.path.toLowerCase() === 'skill.md')?.path || files[0]?.path || '')
  );
  const [text, setText] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!cur) return undefined;
    let alive = true;
    setText(null);
    setErr('');
    api(`/api/skills/content?name=${encodeURIComponent(name)}&ref=${encodeURIComponent(cur)}`)
      .then((d) => { if (alive) setText(d.content); })
      .catch((e) => { if (alive) setErr(String((e && e.message) || e)); });
    return () => { alive = false; };
  }, [name, cur]);

  if (!files.length) return <div className="muted">（这个 skill 目录里没有文件）</div>;
  return (
    <div className="skl-files">
      <div className="skl-tree">
        {files.map((f) => (
          <button
            key={f.path}
            type="button"
            className={'skl-file' + (f.path === cur ? ' on' : '')}
            title={f.path}
            onClick={() => setCur(f.path)}
          >
            <span className="p">{f.path}</span>
            <span className="b">{f.bytes < 1024 ? `${f.bytes} B` : `${Math.round(f.bytes / 1024)} KB`}</span>
          </button>
        ))}
      </div>
      <div className="skl-body">
        {err ? <div className="dlg-msg">读取失败：{err}</div>
          : text === null ? <div className="muted">读取中…</div>
            : <pre>{text}</pre>}
      </div>
    </div>
  );
}

export default function SkillsView() {
  const { boot, ui, patchUi, toggleSel, refreshBoot } = useStore();
  const toast = useToast();
  const guard = useGuard();
  const { dialog, node: dialogNode } = useDialog();

  const [data, setData] = useState(null);
  const [modal, setModal] = useState(null);

  const settings = boot?.settings || {};
  const adapters = boot?.adapters || [];
  const source = ui.source || '';

  // 搜索 / 筛选：48 个 skill 靠滚动找是不行的，先用「名字或描述」命中再谈其它。
  const q = String(ui.q || '').trim().toLowerCase();
  const listFilter = ui.listFilter || 'all';
  const hit = (s) => !q || `${s.name} ${s.description || ''}`.toLowerCase().includes(q);

  // 项目 = 右上角激活的目录（无则服务进程目录）。项目级信息只针对它。
  // 必须声明在 load 之前——load 的依赖数组引用它，声明在后就是 TDZ 白屏。
  const project = ui.activeScope?.path || boot?.projectRoot || '';

  const load = useCallback(async () => {
    const qs = new URLSearchParams();
    if (project) qs.set('project', project);
    if (source) qs.set('source', source);
    const d = await api('/api/skills?' + qs.toString()).catch(() => null);
    setData(d);
  }, [project, source]);

  useEffect(() => { load(); }, [load]);

  const sources = data?.sources || boot?.sources || [];
  // 订阅源的展示名要拿「全部源」才能算出唯一后缀，见 sourceLabel
  const srcPaths = sources.map((s) => s.path);
  const platformOpts = useMemo(
    () => (settings.platforms || []).filter((id) => adapters.some((a) => a.id === id)),
    [settings.platforms, adapters]
  );

  // 勾选集合（持久化）。只在「当前列表里还存在的名字」上生效，避免旧勾选残留。
  const selSkills = useMemo(() => new Set(ui.selSkills), [ui.selSkills]);
  const hubNames = useMemo(() => (data?.skills || []).map((s) => s.name), [data]);
  const orphanNames = useMemo(() => (data?.orphans || []).map((s) => s.name), [data]);
  const selectedNames = useMemo(
    () => ui.selSkills.filter((n) => hubNames.includes(n) || orphanNames.includes(n)),
    [ui.selSkills, hubNames, orphanNames]
  );
  const selectedHub = useMemo(() => selectedNames.filter((n) => hubNames.includes(n)), [selectedNames, hubNames]);
  const selectedOrphans = useMemo(() => selectedNames.filter((n) => orphanNames.includes(n)), [selectedNames, orphanNames]);
  const allSelected = hubNames.length > 0 && hubNames.every((n) => selSkills.has(n));
  const allOrphansSelected = orphanNames.length > 0 && orphanNames.every((n) => selSkills.has(n));
  // 全选 = 并集 / 差集，不是整体替换 —— 否则「全选订阅源」会把已勾的「未入 Hub」清掉，
  // 而用户根本看不出发生了什么（两处勾选长得很像）。顺手把已失效的名字修剪掉。
  const selectAll = (names, on) => patchUi((u) => {
    const keep = u.selSkills.filter((n) => hubNames.includes(n) || orphanNames.includes(n));
    return { selSkills: on ? [...new Set([...keep, ...names])] : keep.filter((n) => !names.includes(n)) };
  });
  const toggleAll = () => selectAll(hubNames, !allSelected);
  const toggleAllOrphans = () => selectAll(orphanNames, !allOrphansSelected);

  // 批量只作用于**勾选的**。「不勾选就是全量」这种隐式语义按钮上写不出来——
  // 用户没法从界面判断这一按下去会动 3 个还是 48 个。要全量就先「全选」，
  // 那是一个看得见的动作。（避免手点 ≠ 允许误点。）
  const bulkMigrate = (to) => guard(async () => {
    const names = selectedHub;
    if (!names.length) { toast('请先勾选要迁移的 skill（表头可全选）'); return; }
    const ok = await dialog({
      message: `将勾选的 ${names.length} 个 skill 迁移到${SCOPE_SHORT[to]}？\n平台: ${platformOpts.join(', ')} · 形态: ${settings.skillSyncMode === 'copy' ? '复制' : '软链接'}`,
    });
    if (!ok) return;
    const r = await api('/api/skills/migrate', {
      method: 'POST',
      body: { name: names, to, platform: 'all', project, mode: settings.skillSyncMode },
    });
    if (r.status === 'blocked') {
      toast(`${r.blocked.length} 处被阻止：同名 skill 在多个订阅源且内容不同（先解决订阅）`);
    } else {
      toast(`已迁移 ${r.migrated} 处（跳过 ${r.skipped}）`);
    }
    await load();
  });

  // 撤销只对勾选生效：全量撤销会把用户级目录里所有链接一并清掉，风险不对等
  const bulkUnmigrate = () => guard(async () => {
    if (!selectedNames.length) { toast('请先勾选要撤销的 skill'); return; }
    const ok = await dialog({
      message: `撤销勾选的 ${selectedNames.length} 个 skill 的迁移？\n链接直接删除；实体副本会被跳过（需逐个确认）。`,
      danger: true,
    });
    if (!ok) return;
    const r = await api('/api/skills/unmigrate', { method: 'POST', body: { name: selectedNames, to: 'all', platform: 'all', project } });
    toast(r.status === 'blocked' ? `${r.needForce.length} 处是实体副本，已跳过` : `已撤销 ${r.removed.length} 处`);
    await load();
  });

  // 批量提交：只提交勾选的「未入 Hub」（同上，不做隐式全量）
  const bulkSubmit = () => guard(async () => {
    if (!source && !data?.hub?.path) { toast('请先订阅一个 skill 目录'); return; }
    const n = selectedOrphans.length;
    if (!n) { toast('请先勾选要提交的 skill（「未入 Hub」表头可全选）'); return; }
    const ok = await dialog({
      message: `把勾选的 ${n} 个「未入 Hub」skill 提交到订阅源？\n提交后会删除目标实文件并改回链接。`,
    });
    if (!ok) return;
    const r = await api('/api/skills/submit', {
      method: 'POST',
      // to:'all' —— 未入 Hub 的 skill 常常躺在**用户级**平台目录里，
      // 写死 'project' 会让提交直接报「目标目录里没有该 skill」（实测踩过）
      body: { name: selectedOrphans, to: 'all', platform: 'all', project },
    });
    toast(`已提交 ${r.submitted} 个（跳过 ${r.skipped}）`);
    await load();
    await refreshBoot();
  });

  // ---- 订阅源操作 ----
  const addSource = () => guard(async () => {
    const p = await dialog({ title: '订阅一个 skill 目录（目录下直接是各 skill）', input: true });
    if (!p) return;
    await api('/api/skills/sources', { method: 'POST', body: { path: p } });
    patchUi({ source: '' });
    await refreshBoot();
    await load();
  });

  const removeSource = () => guard(async () => {
    const cur = source || data?.hub?.path;
    if (!cur) return;
    const ok = await dialog({ message: `取消订阅该目录？（不动磁盘）\n${cur}`, danger: true });
    if (!ok) return;
    await api('/api/skills/sources', { method: 'DELETE', body: { path: cur } });
    patchUi({ source: '' });
    await refreshBoot();
    await load();
  });

  const setSetting = (patch) => guard(async () => {
    await api('/api/settings', { method: 'POST', body: patch });
    await refreshBoot();
    await load();
  });

  // ---- 迁移 / 撤销 ----
  const toggleCell = (name, cell) => guard(async () => {
    const base = { name, to: cell.scope, platform: cell.platform, project };
    if (cell.on) {
      let r = await api('/api/skills/unmigrate', { method: 'POST', body: base });
      if (r.status === 'blocked') {
        const ok = await dialog({
          message: `「${name}」在 ${SCOPE_SHORT[cell.scope]}·${cell.platform} 是实体副本（可能含本地改动）。\n删除不可逆，确认？`,
          danger: true,
        });
        if (!ok) return;
        r = await api('/api/skills/unmigrate', { method: 'POST', body: { ...base, force: true } });
      }
      toast(r.removed?.length ? `已撤销 ${SCOPE_SHORT[cell.scope]}·${cell.platform}` : '该目标本就没有');
    } else {
      // 目的仓库不做冲突检测：订阅源是唯一真相源，直接覆盖（hub 里永远有一份，可恢复）。
      // 真正要检测的是订阅源之间——那个用 skill hub check。
      const r = await api('/api/skills/migrate', {
        method: 'POST',
        body: { ...base, mode: settings.skillSyncMode },
      });
      if (r.status === 'blocked') {
        toast(`${name} 在多个订阅源且内容不同，先解决订阅（skill hub check）`);
        await load();
        return;
      }
      toast(`已迁移到 ${SCOPE_SHORT[cell.scope]}·${cell.platform}`);
    }
    await load();
  });

  const migrateScope = (name, to) => guard(async () => {
    const r = await api('/api/skills/migrate', {
      method: 'POST',
      body: { name, to, platform: 'all', project, mode: settings.skillSyncMode },
    });
    toast(r.status === 'blocked' ? '同名 skill 在多个订阅源且内容不同，先解决订阅' : `已迁移到${SCOPE_SHORT[to]}`);
    await load();
  });

  // to 缺省 'all'：未入 Hub 的 skill 常常躺在**用户级**平台目录里，写死 'project'
  // 会让提交直接报「目标目录里没有该 skill」（实测确认过）。让服务端按落点自己找。
  const submit = (name, to = 'all') => guard(async () => {
    const cur = source || data?.hub?.path;
    if (!cur) { toast('请先订阅一个 skill 目录'); return; }
    const r = await api('/api/skills/submit', { method: 'POST', body: { name, to, platform: 'all', project } });
    if (r.status === 'conflict') {
      const ok = await dialog({ message: `订阅源已有同名 skill 且内容不同（${r.files.length} 个文件）。\n用这份副本覆盖订阅源？` });
      if (!ok) return;
      await api('/api/skills/submit', { method: 'POST', body: { name, to, platform: 'all', project, force: true } });
    }
    toast(`已提交到订阅源，目标实文件已删除`);
    await load();
    await refreshBoot();
  });

  // 注：「查看全文」曾是这里的一个独立弹窗，只读 SKILL.md 且只认订阅源
  // （未入 Hub 的 skill 点它必然 NOT_FOUND）。现在全文并入详情弹窗的文件面板，
  // 见 openDetail / SkillFiles。

  const hubPath = data?.hub?.path || boot?.hub?.path || '';

  // 「未入 Hub」两组：当前项目一组（按项目目录收拢，不看平台），用户级一组。
  // 一个 skill 同时在项目与用户级存在时归项目组——那是更该处理的一侧，
  // 用户级形态仍能在详情弹窗里看到并单独操作。
  const orphanGroups = useMemo(() => {
    const projName = String(project || '').replace(/^.*[\\/]/, '');
    const mk = (key, scope, label) => ({ key, scope, label, items: [], buckets: new Map() });
    const proj = mk('project', 'project', projName ? `项目 · ${projName}` : '项目');
    const user = mk('user', 'user', '用户级');
    for (const o of data?.orphans || []) {
      if (q && !`${o.name} ${o.description || ''}`.toLowerCase().includes(q)) continue;
      const cells = (o.cells || []).filter((c) => platformOpts.includes(c.platform));
      if (!cells.length) continue;
      const hasProj = cells.some((c) => c.scope === 'project');
      const g = hasProj ? proj : user;
      g.items.push(o);
      // 组内再按平台各自聚合：一个平台目录一行，直接写清「哪个平台 · 哪个目录」，
      // 比「等 2 个目录」有用——不说平台名，用户根本不知道那份副本是给谁用的。
      for (const c of cells) {
        if ((c.scope === 'project') !== hasProj) continue;
        const b = g.buckets.get(c.platform) || {
          platform: c.platform,
          platformName: c.platformName || c.platform,
          dir: String(c.dir || '').replace(/[\\/][^\\/]+$/, ''),
          items: [],
        };
        b.items.push(o);
        g.buckets.set(c.platform, b);
      }
    }
    const finish = (g) => ({
      ...g,
      // 平台名一览给组表头用；子表头按平台名排
      bucketList: [...g.buckets.values()].sort((a, b) => a.platformName.localeCompare(b.platformName)),
    });
    // 项目组在前；用户级游离大多是本机常驻旧副本，属于次要信息
    return [finish(proj), finish(user)].filter((g) => g.items.length);
  }, [data, platformOpts, project, q]);

  // 分组各自的展开状态（会话级，不持久化）：默认项目组展开、用户组收起
  const [groupOpen, setGroupOpen] = useState({});
  // 默认：项目组展开、用户组收起；搜索时两组都展开（命中就在里面，别让用户再点一次）
  const isGroupOpen = (g) => groupOpen[g.key] ?? (g.scope === 'project' || !!q);
  const toggleGroup = (g) => setGroupOpen((m) => ({ ...m, [g.key]: !isGroupOpen(g) }));

  // 平台子组各自的展开状态（会话级）：外层组（项目 / 用户级）之下的 Claude Code / WorkBuddy 那一层。
  // 默认全部展开——它就是内容本身；能收起是为了「一次只盯一个平台」。
  const [bucketOpen, setBucketOpen] = useState({});
  const bucketKey = (g, b) => `${g.key}/${b.platform}`;
  const isBucketOpen = (g, b) => bucketOpen[bucketKey(g, b)] ?? true;
  const toggleBucket = (g, b) => setBucketOpen((m) => ({ ...m, [bucketKey(g, b)]: !isBucketOpen(g, b) }));

  // 未入 Hub 默认收起（ui.orphansOpen）：它只是「待收敛」的提示，不是日常要看的信息。
  // 收起时表头仍给出数量与作用域分布，不至于完全丢信息。
  // 例外：正在搜索且这里有命中 → 自动展开，否则用户会以为「搜不到」。
  const orphanProjCount = orphanGroups.find((g) => g.scope === 'project')?.items.length || 0;
  const orphanUserCount = orphanGroups.find((g) => g.scope === 'user')?.items.length || 0;
  const orphanCount = orphanProjCount + orphanUserCount;
  const orphansOpen = !!ui.orphansOpen || (!!q && orphanCount > 0);

  // ---- 详情弹窗：查看 + 操作都收进来，行上只留一个入口（轻量） ----
  const closeModal = () => setModal(null);
  const reloadAll = useCallback(async () => { await load(); await refreshBoot(); }, [load, refreshBoot]);

  // 新建（C）：写入当前订阅源
  const openCreate = () => {
    setModal({
      title: '新建 skill（写入当前订阅源）',
      node: <SkillEditor mode="create" close={closeModal} reload={reloadAll} />,
    });
  };

  // 编辑（U）：载入 SKILL.md 全文，改完 PATCH 回去
  const openEditor = (s) => guard(async () => {
    const d = await api('/api/skills/content?name=' + encodeURIComponent(s.name));
    setModal({
      title: `编辑 skill · ${s.name}`,
      node: (
        <SkillEditor
          mode="edit"
          skill={{ name: s.name, description: s.description, content: d.content }}
          close={closeModal}
          reload={reloadAll}
        />
      ),
    });
  });

  // 删除（D）：目标侧还有引用时先 blocked，确认后才删
  const doDelete = (s) => guard(async () => {
    const ok = await dialog({ message: `从订阅源删除「${s.name}」？`, danger: true });
    if (!ok) return;
    const r = await api('/api/skills/' + encodeURIComponent(s.name), { method: 'DELETE', body: {} });
    if (r.status === 'blocked') {
      const ok2 = await dialog({
        message: `${r.reason}：\n${r.refs.map((x) => `${SCOPE_SHORT[x.scope]}·${x.platform} ${x.path}`).join('\n')}\n仍要删除？（目标侧会悬空，之后可用迁移重建）`,
        danger: true,
      });
      if (!ok2) return;
      await api('/api/skills/' + encodeURIComponent(s.name), { method: 'DELETE', body: { force: true } });
    }
    closeModal();
    await reloadAll();
    toast('已删除');
  });

  // 彻底删除：先 dry-run 拿「将删除哪些路径」的清单，确认后才落盘。
  // 与 env 页同一套流程——这是面板上少数几个不可逆的操作，用户必须先看见会发生什么。
  const doPurge = (name) => guard(async () => {
    const dry = await api('/api/skills/purge', { method: 'POST', body: { name, 'dry-run': true } });
    const p = dry.plan;
    const lines = [
      ...p.targets.map((c) => `  落点    ${SCOPE_SHORT[c.scope]}·${c.platformName}  ${c.path}${c.linkType ? '（链接）' : '（实体副本）'}`),
      ...p.sources.map((s) => `  订阅源  ${s.source}\n          → ${s.dir}`),
    ];
    const ok = await dialog({
      title: `彻底删除 ${name}`,
      message: `将删除以下 ${lines.length} 处，不可恢复：\n${lines.join('\n')}`
        + (p.copies ? `\n\n其中 ${p.copies} 处是实体副本，可能含本地改动。` : '')
        + (p.sources.length ? '\n\n订阅源那份也会删掉——不删的话，下次迁移会把它原样带回来。' : ''),
      danger: true,
      okText: '删除',
    });
    if (!ok) return;
    const r = await api('/api/skills/purge', { method: 'POST', body: { name, force: true } });
    closeModal();
    await reloadAll();
    toast(`已彻底删除 ${name}（${r.removed.length} 处）`);
  });

  // 详情 = 完整查看。内容现拉，而不是复用列表行——列表里未入 Hub 的 skill
  // 根本没有 outline / files / source，而它恰恰是最需要看清楚的那个。
  const openDetail = (s, { orphan } = {}) => guard(async () => {
    const d = await api('/api/skills/detail?name=' + encodeURIComponent(s.name));
    const cells = (d.cells || []).filter((c) => platformOpts.includes(c.platform));
    const isOrphan = orphan || d.origin === 'link' || d.origin === 'target';
    const copySkillMd = () => {
      api(`/api/skills/content?name=${encodeURIComponent(s.name)}`)
        .then((x) => { navigator.clipboard?.writeText(x.content); toast('已复制 SKILL.md'); })
        .catch((e) => toast(String((e && e.message) || e)));
    };
    setModal({
      title: `skill · ${s.name}`,
      node: (
        <>
          <div className="row-inline" style={{ alignItems: 'flex-start', gap: 12, marginBottom: 8 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="muted" style={{ marginBottom: 4 }}>{d.description}</div>
              <div className="muted">
                {d.source ? <>来源: <Copyable text={d.source}>{d.source}</Copyable>{' · '}</> : null}
                {d.dir ? <>目录: <Copyable text={d.dir}>{d.dir}</Copyable></> : null}
                {d.stats?.lines
                  ? <> · {d.stats.sections ?? d.outline.length} 节 · {d.stats.lines} 行 · {d.files.length} 个文件</>
                  : null}
              </div>
            </div>
            <button className="btn small ghost" onClick={copySkillMd}>复制 SKILL.md</button>
          </div>

          {isOrphan ? (
            <div style={{ marginBottom: 8 }}>
              <span
                className="tag bad"
                title="订阅源里没有它；内容读的是平台目录里那份落点（链接就顺着链接读）"
              >
                {d.origin === 'link' ? '不在订阅源（游离链接）' : '不在订阅源（未入 Hub）'}
              </span>
              {d.linkTarget ? (
                <span className="muted" style={{ marginLeft: 8 }}>
                  → <Copyable text={d.linkTarget}>{d.linkTarget}</Copyable>
                </span>
              ) : null}
            </div>
          ) : null}
          {d.conflict && !d.conflict.same ? (
            <div style={{ marginBottom: 8 }}>
              <span className="tag bad" title={d.conflict.sources.map((x) => x.path).join('\n')}>
                跨源冲突：同名实文件在多个订阅源且内容不同，迁移会被阻止（skill hub check）
              </span>
            </div>
          ) : null}

          {/* 断链没有内容可读，但这件事本身要说明白 —— 它是最该被清掉的那种残留 */}
          {d.broken ? (
            <div className="dlg-msg" style={{ marginBottom: 8 }}>
              这是个断链：目标已经不存在，所以读不到内容。
              {d.linkTarget ? `（指向 ${d.linkTarget}）` : ''}
              {'\n'}留着它只会让 agent 以为这个 skill 还在——用下面的「彻底删除」可以把它清掉。
            </div>
          ) : null}

          {/* 完整查看：文件树 + 全文。未入 Hub 的 skill 走的是同一条路 */}
          {d.broken ? null : <SkillFiles name={s.name} files={d.files || []} />}

          <div className="colhead" style={{ marginTop: 14, gap: 10 }}>
            <h3>平台落点</h3>
            <span className="muted">链接随订阅源实时变；实体副本是独立的一份</span>
          </div>
          <div className="list">
            {cells.length ? cells.map((c) => (
              <div key={c.scope + c.platform} className="row">
                <span className="name">{SCOPE_SHORT[c.scope]}·{shortLabel(c.platform, adapters)}</span>
                <Copyable className="desc" text={c.dir} title="点击复制落点路径">{c.dir}</Copyable>
                <span
                  className={'tag' + (c.on ? (c.linkType ? '' : ' strong') : ' bad')}
                  title={c.on ? (c.linkType ? '软链接，随订阅源实时同步' : '实体副本') : '尚未迁移'}
                >
                  {c.on ? (c.linkType ? '链接' : '实体') : '未迁移'}
                </span>
                <span className="acts">
                  <button
                    className={'btn small' + (c.on ? ' ghost' : '')}
                    onClick={() => { closeModal(); toggleCell(s.name, c); }}
                  >
                    {c.on ? '撤销' : '迁移'}
                  </button>
                </span>
              </div>
            )) : <div className="row muted">（当前启用的平台没有落点）</div>}
          </div>

          <div className="dlg-acts" style={{ flexWrap: 'wrap' }}>
            {isOrphan ? (
              <button className="btn" onClick={() => { closeModal(); submit(s.name, 'all'); }}>提交到订阅源</button>
            ) : (
              <>
                <button className="btn" onClick={() => { closeModal(); migrateScope(s.name, 'project'); }}>迁移 → 项目</button>
                <button className="btn" onClick={() => { closeModal(); migrateScope(s.name, 'user'); }}>迁移 → 用户</button>
                <button className="btn ghost" onClick={() => openEditor(s)}>编辑</button>
                <button className="btn ghost" title="只从订阅源下架，保留各平台落点" onClick={() => doDelete(s)}>从订阅源删除</button>
              </>
            )}
            <button
              className="btn danger"
              title="所有平台落点 + 订阅源里的实文件一并删除"
              onClick={() => doPurge(s.name)}
            >
              彻底删除…
            </button>
          </div>
        </>
      ),
    });
  });

  // 行上的状态只用**一个**标签表达：勋章按「平台 × 作用域」线性膨胀（2 平台 4 个、
  // 4 平台 8 个），行里根本放不下。逐落点的迁移 / 撤销归详情页的竖向列表。
  const rowCells = (s) => (s.cells || []).filter((c) => platformOpts.includes(c.platform));
  const cellState = (s, orphan) => {
    const cells = rowCells(s);
    if (!cells.length) return '—';
    if (orphan) return `${cells.length} 处`;
    const on = cells.filter((c) => c.on).length;
    return on ? `已迁移 ${on}/${cells.length}` : '未迁移';
  };
  const cellSummary = (s) =>
    rowCells(s)
      .map((c) => `${SCOPE_SHORT[c.scope]}·${c.platformName || shortLabel(c.platform, adapters)}：${c.on ? (c.linkType || '实体') : '未迁移'}`)
      .join('\n');

  // 列表过滤：搜索（名称/描述）+ 三态筛选。计数给表头用，避免「筛完看不到总共多少」
  const allSkills = data?.skills || [];
  const visibleSkills = allSkills.filter((s) => {
    if (!hit(s)) return false;
    if (listFilter === 'todo') return !(rowCells(s).length && rowCells(s).every((c) => c.on));
    if (listFilter === 'conflict') return !!s.conflict;
    return true;
  });
  const filtered = !!q || listFilter !== 'all';

  const renderRow = (s, { orphan } = {}) => (
    <div
      key={s.name}
      className="row skl"
      style={{ cursor: 'pointer' }}
      title="点击查看详情与操作（逐落点的迁移 / 撤销在里面）"
      onClick={() => openDetail(s, { orphan })}
    >
      <input
        type="checkbox"
        checked={selSkills.has(s.name)}
        title="勾选后可用于批量操作"
        onClick={(e) => e.stopPropagation()}
        onChange={() => toggleSel('selSkills', s.name)}
      />
      <span className="name" title={s.name}>{s.name}</span>
      {/* 描述是「次要信息」：11px 灰字、单行截断，悬停看全文 */}
      <span className="desc" title={s.description || ''}>{s.description}</span>
      {orphan ? (
        <span className="tag bad" title="不在订阅源里，实文件散落在平台目录">未入 Hub</span>
      ) : s.conflict && !s.conflict.same ? (
        <span
          className="tag bad"
          title={`同名 skill 在多个订阅源且内容不同：${s.conflict.sources.map((x) => x.path).join('\n')}\n迁移会被阻止，先解决订阅或用 --source 指定`}
        >
          跨源冲突
        </span>
      ) : s.conflict ? (
        <span className="tag" title={`同名实文件在多个订阅源（内容一致）:\n${s.conflict.sources.map((x) => x.path).join('\n')}`}>
          重复订阅
        </span>
      ) : (
        <span
          className="tag"
          title={`来源: ${s.source || '（未知）'}${s.alsoIn?.length ? `\n同时存在于:\n${s.alsoIn.join('\n')}` : ''}`}
        >
          {sourceLabel(s.source, srcPaths)}
        </span>
      )}
      {/* 一个汇总标签（不随平台数膨胀），明细与逐落点操作在详情页的竖向列表里 */}
      <span
        className={'tag' + (orphan ? ' bad' : rowCells(s).length && rowCells(s).every((c) => c.on) ? ' strong' : '')}
        title={cellSummary(s) || '当前启用的平台没有落点'}
      >
        {cellState(s, orphan)}
      </span>
      <span className="acts">
        <button
          className="btn small ghost"
          onClick={(e) => { e.stopPropagation(); openDetail(s, { orphan }); }}
        >
          详情
        </button>
      </span>
    </div>
  );

  return (
    <>
      {/* 一屏一条工具栏，只留「浏览（搜索 / 筛选）」与最常用的两个动作。
          订阅源 / 默认平台 / 迁移形态是**配置**——改一次管很久，却原来和搜索平铺了两行；
          折进「设置」。批量是**操作**，选中之后才出现（它自己也携带「你现在选了什么」）。 */}
      <div className="toolbar">
        {/* 搜索放最前：48 个 skill，先能找再谈别的 */}
        <input
          className="search grow"
          type="search"
          placeholder="搜索名称 / 描述…（Esc 清空）"
          value={ui.q || ''}
          onChange={(e) => patchUi({ q: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Escape') patchUi({ q: '' }); }}
        />
        <select
          value={listFilter}
          title="筛选列表：未迁移 = 还有落点没铺；跨源冲突 = 多订阅源同名不同内容"
          onChange={(e) => patchUi({ listFilter: e.target.value })}
        >
          <option value="all">全部</option>
          <option value="todo">未迁移</option>
          <option value="conflict">跨源冲突</option>
        </select>
        <button className="btn ghost" title="重新读取订阅源与各平台目录" onClick={() => guard(load)}>刷新</button>
        <details className="tb-set">
          <summary title="订阅源 / 默认平台 / 迁移形态 / 当前项目">
            设置{data && !data.hub?.path ? ' · 尚未订阅' : ''}
          </summary>
          <div className="tb-set-box">
            <div className="row-inline">
              <label>订阅源</label>
              <select
                value={source}
                title={hubPath ? '当前主源: ' + hubPath : '尚未订阅 Skill Hub'}
                onChange={(e) => patchUi({ source: e.target.value })}
              >
                <option value="">（当前主源）</option>
                {sources.map((s) => (
                  <option key={s.path} value={s.path} title={s.path}>
                    {sourceLabel(s.path, srcPaths)}  ({s.count}){s.current ? ' · 主源' : ''}
                  </option>
                ))}
              </select>
              <button className="btn small ghost" title="订阅 skill 目录" onClick={addSource}>＋</button>
              <button className="btn small ghost" title="取消订阅（不动磁盘）" onClick={removeSource}>－</button>
            </div>
            <div className="row-inline">
              <label>默认平台</label>
              <select value={settings.defaultPlatform || platformOpts[0]}
                onChange={(e) => setSetting({ defaultPlatform: e.target.value })}>
                {platformOpts.map((id) => (
                  <option key={id} value={id}>{(adapters.find((a) => a.id === id) || {}).name || id}</option>
                ))}
              </select>
            </div>
            <div className="row-inline">
              <label>迁移形态</label>
              <select value={settings.skillSyncMode === 'copy' ? 'copy' : 'symlink'}
                onChange={(e) => setSetting({ skillSyncMode: e.target.value })}>
                <option value="symlink">软链接（改订阅源即时生效）</option>
                <option value="copy">复制（目标侧是独立副本）</option>
              </select>
            </div>
            <div className="row-inline">
              <label>当前项目</label>
              <span
                className="mono muted"
                title={project ? '项目级信息只针对右上角激活的这个目录' : '右上角「最近目录」可切换项目'}
              >
                {project || '（跟随服务进程目录）'}
              </span>
            </div>
          </div>
        </details>
      </div>

      {/* 操作条：选中之后才出现。它同时是「你现在选了什么」的可见凭据——
          勾选是持久化的，没有这条就可能在下次打开时对着一个看不见的选择按下去。 */}
      {selectedNames.length ? (
        <div className="toolbar bulk">
          <span className="muted">
            已选 <b>{selectedNames.length}</b> 个（订阅源 {selectedHub.length} · 未入 Hub {selectedOrphans.length}）
          </span>
          <button
            className="btn"
            disabled={!selectedHub.length}
            title={selectedHub.length ? undefined : '勾选里没有订阅源 skill'}
            onClick={() => bulkMigrate('project')}
          >→ 项目</button>
          <button
            className="btn"
            disabled={!selectedHub.length}
            title={selectedHub.length ? undefined : '勾选里没有订阅源 skill'}
            onClick={() => bulkMigrate('user')}
          >→ 用户</button>
          <button className="btn ghost" onClick={bulkUnmigrate}>撤销迁移</button>
          <button
            className="btn ghost"
            disabled={!selectedOrphans.length}
            title={selectedOrphans.length ? undefined : '勾选里没有「未入 Hub」的 skill'}
            onClick={bulkSubmit}
          >提交到订阅源</button>
          <button className="btn ghost" onClick={() => patchUi({ selSkills: [] })}>清除选择</button>
        </div>
      ) : null}

      <div className="card">
        <div className="colhead">
          <h3>订阅源 Skill</h3>
          <span className="muted">
            <input type="checkbox" checked={allSelected} title="全选 / 全不选" onChange={toggleAll} />
            {' '}
            {filtered ? `显示 ${visibleSkills.length} / ${allSkills.length}` : `${allSkills.length}`} 个
            {hubPath ? <span title={'当前主源: ' + hubPath}> · {sourceLabel(hubPath, srcPaths)}</span> : null}
            {filtered ? (
              <button
                className="btn small ghost"
                style={{ marginLeft: 8 }}
                title="清除搜索与筛选"
                onClick={() => patchUi({ q: '', listFilter: 'all' })}
              >
                清除筛选
              </button>
            ) : null}
            {hubPath ? (
              <button className="btn small" style={{ marginLeft: 8 }} title="在当前订阅源新建一个 skill" onClick={openCreate}>
                ＋ 新建
              </button>
            ) : null}
          </span>
        </div>
        <div className="list">
          {visibleSkills.length
            ? visibleSkills.map((s) => renderRow(s))
            : allSkills.length
              ? <div className="row muted">没有匹配的 skill（当前搜索「{ui.q}」）
                  　<button className="btn small ghost" onClick={() => patchUi({ q: '', listFilter: 'all' })}>清除筛选</button>
                </div>
              : <div className="row muted">（订阅源里暂无 skill；点上方＋订阅一个 skill 目录）</div>}
        </div>
      </div>

      <div className="card">
        <div className="colhead">
          <h3>
            <button
              className="disclose"
              title="未入 Hub 是次要信息，默认收起；展开后按平台目录分组"
              onClick={() => patchUi({ orphansOpen: !orphansOpen })}
            >
              <span className="caret">{orphansOpen ? '▾' : '▸'}</span> 未入 Hub
            </button>
            <span className="muted">
              {/* 只报非零的作用域：「项目 0」这种零值只是噪音，还会让人以为这里出错了 */}
              {' '}{orphanCount} 个
              {orphanProjCount ? ` · 项目 ${orphanProjCount}` : ''}
              {orphanUserCount ? ` · 用户级 ${orphanUserCount}` : ''}
              {q && orphanCount ? ` · 匹配「${ui.q}」` : ''}
              {orphanCount ? (
                <span style={{ marginLeft: 10 }}>
                  <input
                    type="checkbox"
                    checked={allOrphansSelected}
                    title="全选 / 全不选「未入 Hub」——批量提交需要先勾选"
                    onChange={toggleAllOrphans}
                  />
                  {' '}全选
                </span>
              ) : null}
            </span>
          </h3>
        </div>
        <div className="list" hidden={!orphansOpen}>
          {orphanGroups.length ? (
            orphanGroups.map((g) => (
              <Fragment key={g.key}>
                <div className="colhead" style={{ padding: '0 12px' }}>
                  <h3 style={{ fontSize: 12, fontWeight: 600 }}>
                    <button className="disclose" title="展开 / 收起这一组" onClick={() => toggleGroup(g)}>
                      <span className="caret">{isGroupOpen(g) ? '▾' : '▸'}</span> {g.label}
                    </button>
                    <span className="muted" style={{ fontWeight: 400 }}>  {g.items.length} 个</span>
                  </h3>
                  <span className="muted">{g.bucketList.map((b) => b.platformName).join(' · ')}</span>
                </div>
                {isGroupOpen(g)
                  ? g.bucketList.map((b) => (
                      <Fragment key={b.platform}>
                        <div className="subhead">
                          <button
                            className="disclose"
                            title="展开 / 收起这个平台组"
                            onClick={() => toggleBucket(g, b)}
                          >
                            <span className="caret">{isBucketOpen(g, b) ? '▾' : '▸'}</span> {b.platformName}
                          </button>
                          <Copyable className="path" text={b.dir} title="点击复制该平台的目录">{b.dir}</Copyable>
                          <span>{b.items.length} 个</span>
                        </div>
                        {isBucketOpen(g, b) ? b.items.map((o) => renderRow(o, { orphan: true })) : null}
                      </Fragment>
                    ))
                  : null}
              </Fragment>
            ))
          ) : (
            <div className="row muted">（没有游离的 skill）</div>
          )}
        </div>
      </div>


      <CliHints module="skills" />

      {modal ? <Modal title={modal.title} onClose={() => setModal(null)}>{modal.node}</Modal> : null}
      {dialogNode}
    </>
  );
}
