// nx-rh 面板逻辑：全部操作走 /api，与 CLI 共享同一 service 层。
// 约定：无 emoji、不使用浏览器原生弹窗（alert/confirm/prompt 一律走页内 toast/对话框）。
const $ = (s, el = document) => el.querySelector(s);

const state = {
  settings: null,
  adapters: [],
  storePath: '',
  repos: [],
  statuses: [],
  centralSkills: [],
  projectSkills: [],
  selCentral: new Set(),
  selProject: new Set(),
  bundled: null,
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let json;
  try { json = await res.json(); } catch { throw new Error('HTTP ' + res.status); }
  if (!json.ok) throw new Error(json.error || '请求失败');
  return json.data;
}

// ---- 页内提示与对话框（取代浏览器原生弹窗） ----

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 2600);
}

// 通用对话框：input 为真时是输入框（返回字符串或 null），否则是确认框（返回 true/null）
function dialog({ title = '', message = '', input = false, placeholder = '', value = '', okText = '确定', danger = false } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'dlg';
    overlay.innerHTML = `
      <div class="dlg-box">
        ${title ? `<div class="dlg-title">${esc(title)}</div>` : ''}
        ${message ? `<div class="dlg-msg">${esc(message)}</div>` : ''}
        ${input ? `<input class="dlg-input" placeholder="${esc(placeholder)}" value="${esc(value)}" spellcheck="false">` : ''}
        <div class="dlg-acts">
          <button class="btn ghost" data-r="cancel">取消</button>
          <button class="btn${danger ? ' danger' : ''}" data-r="ok">${esc(okText)}</button>
        </div>
      </div>`;
    const done = (val) => { overlay.remove(); resolve(val); };
    overlay.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-r]');
      if (b) done(b.dataset.r === 'ok' ? (input ? overlay.querySelector('.dlg-input').value.trim() : true) : null);
      else if (e.target === overlay) done(null);
    });
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') done(null);
      if (e.key === 'Enter') {
        const inp = overlay.querySelector('.dlg-input');
        done(inp ? inp.value.trim() : true);
      }
    });
    document.body.appendChild(overlay);
    (overlay.querySelector('.dlg-input') || overlay.querySelector('button[data-r="ok"]')).focus();
  });
}
const askConfirm = (message, danger = false) => dialog({ message, danger }).then((v) => v === true);
const askPrompt = (title, placeholder = '') => dialog({ title, input: true, placeholder });

async function guard(fn) {
  try { return await fn(); } catch (e) { toast(String((e && e.message) || e)); }
}

// ---- 标签页（切换时自动加载对应数据） ----
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + btn.dataset.tab));
    if (btn.dataset.tab === 'skills') guard(loadSkills);
    if (btn.dataset.tab === 'repos') guard(loadRepos);
    if (btn.dataset.tab === 'github') guard(loadGhStatus);
  });
});

// ---- 弹窗（diff / 冲突详情） ----
function openModal(title, node) {
  $('#modalTitle').textContent = title;
  const body = $('#modalBody');
  body.innerHTML = '';
  body.appendChild(node);
  $('#modal').classList.remove('hidden');
}
function closeModal() { $('#modal').classList.add('hidden'); }
$('#modalClose').addEventListener('click', closeModal);
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

function preNode(text) {
  const pre = document.createElement('pre');
  const lines = String(text ?? '').split('\n');
  lines.forEach((line, i) => {
    const span = document.createElement('span');
    if (line.startsWith('+') && !line.startsWith('+++')) span.className = 'd-add';
    else if (line.startsWith('-') && !line.startsWith('---')) span.className = 'd-del';
    span.textContent = line;
    pre.appendChild(span);
    if (i < lines.length - 1) pre.appendChild(document.createTextNode('\n'));
  });
  return pre;
}

function opt(value, label, selected) {
  return `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
}

// ================= 仓库页 =================

function statusCell(g) {
  if (!g) return '<span class="muted">未刷新</span>';
  if (g.error) return '<span class="muted">非 git 仓库</span>';
  if (g.conflicted.length) return `<span class="bad">冲突 ${g.conflicted.length} 文件</span>`;
  if (g.clean) return '<span class="muted">干净</span>';
  const bits = [];
  if (g.ahead) bits.push(`领先 ${g.ahead}`);
  if (g.behind) bits.push(`落后 ${g.behind}`);
  const changed = g.staged.length + g.modified.length;
  if (changed) bits.push(`变更 ${changed}`);
  if (g.untracked.length) bits.push(`未跟踪 ${g.untracked.length}`);
  return bits.join(' · ') || '有变更';
}

function renderRepos() {
  const tbody = $('#repoTable tbody');
  if (!state.repos.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="muted">（暂无仓库，上方添加或扫描）</td></tr>';
    return;
  }
  tbody.innerHTML = state.repos
    .map((r) => {
      const g = state.statuses.find((s) => s.id === r.id)?.git;
      return `<tr>
        <td>${esc(r.name)}${r.desc ? `<div class="muted" style="font-size:11px">${esc(r.desc)}</div>` : ''}</td>
        <td class="path">${esc(r.path)}</td>
        <td>${r.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</td>
        <td class="mono">${esc(g?.branch || '-')}</td>
        <td>${statusCell(g)}</td>
        <td class="ops">
          <button class="btn small ghost" data-act="diff" data-id="${esc(r.id)}">diff</button>
          <button class="btn small ghost" data-act="pull" data-id="${esc(r.id)}">pull</button>
          <button class="btn small ghost" data-act="push" data-id="${esc(r.id)}">push</button>
          <button class="btn small ghost" data-act="open" data-id="${esc(r.id)}">打开</button>
          <button class="btn small ghost" data-act="copy" data-path="${esc(r.path)}">复制路径</button>
          <button class="btn small ghost" data-act="del" data-id="${esc(r.id)}" data-name="${esc(r.name)}">删除</button>
        </td>
      </tr>`;
    })
    .join('');
}

async function loadRepos() {
  state.repos = await api('/api/repos');
  renderRepos();
  renderSelectors(); // 仓库同时是 skill 项目候选
}

async function refreshStatuses() {
  state.statuses = await api('/api/repos/status');
  renderRepos();
}

$('#repoAdd').addEventListener('click', () => guard(async () => {
  const path = $('#repoPath').value.trim();
  if (!path) { toast('请输入仓库路径'); return; }
  await api('/api/repos', {
    method: 'POST',
    body: {
      path,
      name: $('#repoName').value.trim() || undefined,
      desc: $('#repoDesc').value.trim() || undefined,
      tags: $('#repoTags').value.trim() || undefined,
    },
  });
  $('#repoPath').value = ''; $('#repoName').value = ''; $('#repoDesc').value = ''; $('#repoTags').value = '';
  await loadRepos();
}));

$('#repoScan').addEventListener('click', () => guard(async () => {
  const root = $('#scanRoot').value.trim();
  if (!root) { toast('请输入扫描根目录'); return; }
  const r = await api('/api/repos/scan', { method: 'POST', body: { root, depth: parseInt($('#scanDepth').value, 10) || 3 } });
  toast(`扫描完成：发现 ${r.scanned} 个 git 仓库，新登记 ${r.added.length} 个`);
  await loadRepos();
}));

$('#repoRefresh').addEventListener('click', () => guard(refreshStatuses));

$('#repoTable').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const { act, id } = btn.dataset;
  guard(async () => {
    if (act === 'diff') {
      openModal('diff', preNode(await api(`/api/repos/diff?id=${encodeURIComponent(id)}`)));
    } else if (act === 'pull') {
      const r = await api('/api/repos/pull', { method: 'POST', body: { id } });
      let text = r.output || '(无输出)';
      if (r.conflicted?.length) {
        text += '\n\n冲突文件（CLI 逐个落地）:\n' + r.conflicted.map((f) => `  nx-rh repo resolve ${id} --file "${f}" --side ours|theirs`).join('\n');
      }
      openModal('pull 结果', preNode(text));
      await refreshStatuses();
    } else if (act === 'push') {
      const r = await api('/api/repos/push', { method: 'POST', body: { id } });
      openModal('push 结果', preNode(r.output || '(无输出)'));
      await refreshStatuses();
    } else if (act === 'open') {
      await api('/api/repos/open', { method: 'POST', body: { id } });
    } else if (act === 'copy') {
      try { await navigator.clipboard.writeText(btn.dataset.path); } catch { toast('复制失败'); }
    } else if (act === 'del') {
      if (!(await askConfirm(`删除仓库登记「${btn.dataset.name}」？（仅移除登记，磁盘文件不受影响）`, true))) return;
      await api(`/api/repos/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await loadRepos();
    }
  });
});

// ================= Skill 页 =================

function shortLabel(adapterId) {
  const a = state.adapters.find((x) => x.id === adapterId);
  const src = a ? a.name : adapterId;
  return src.replace(/\s*\(.*\)$/, '').split(/[\s-]/)[0].toLowerCase();
}

// 平台范围（设置层勾选的平台），至少兜底 claude-code
function platformScope() {
  const known = new Set(state.adapters.map((a) => a.id));
  const scope = (state.settings?.platforms || []).filter((id) => known.has(id));
  return scope.length ? scope : ['claude-code'];
}

// 项目内 pill 范围 = 设置范围 ∪ 旁系 skill 在用的平台 ∪ 自身平台。
// 旁系（同项目其他 skill）用过的平台也出现，才能在项目内部做平台迁移。
function pillScope(skill) {
  const set = new Set(platformScope());
  for (const x of state.projectSkills) {
    for (const p of x.platforms || []) set.add(p.id);
  }
  for (const p of skill.platforms || []) set.add(p.id);
  return [...set];
}

// 平台小按钮：勾选 = 给该平台提供此 skill；配合开关即可在项目内迁移平台
function platformPills(skill) {
  const on = new Set((skill.platforms || []).map((p) => p.id));
  return `<span class="plats">${pillScope(skill)
    .map((id) => {
      const p = (skill.platforms || []).find((x) => x.id === id);
      const isOn = !!p;
      const lt = p?.linkType || '';
      const cls = isOn ? `pill on ${lt ? 'lnk' : 'real'}` : 'pill';
      const sibling = (state.projectSkills || []).some(
        (x) => x.name !== skill.name && (x.platforms || []).some((pp) => pp.id === id)
      );
      const title = `${(state.adapters.find((a) => a.id === id) || {}).name || id}${
        isOn ? '（已提供 · ' + (lt ? lt + ' 链接' : '实体') + '）' : sibling ? '（旁系 skill 在用，可迁移）' : '（未提供）'
      }`;
      return `<button class="${cls}" title="${esc(title)}" data-act="toggle-platform" data-name="${esc(skill.name)}" data-adapter="${esc(id)}" data-on="${isOn ? '1' : '0'}">${esc(shortLabel(id))}</button>`;
    })
    .join('')}</span>`;
}

function projectStateTag(s) {
  const c = state.centralSkills.find((x) => x.name === s.name);
  if (!c) return '<span class="tag">本地</span>';
  if ((s.platforms || []).some((p) => p.linkType)) return '<span class="tag strong">链接</span>';
  return c.md5 === s.md5 ? '<span class="tag strong">一致</span>' : '<span class="tag bad">冲突</span>';
}

function relationTag(c) {
  const proj = state.projectSkills.find((s) => s.name === c.name);
  if (!proj) return '<span class="tag">仅中心</span>';
  if ((proj.platforms || []).some((p) => p.linkType)) return '<span class="tag strong">链接</span>';
  return proj.md5 === c.md5 ? '<span class="tag strong">一致</span>' : '<span class="tag bad">冲突</span>';
}

function renderSkills() {
  const cl = $('#centralList');
  cl.innerHTML = state.centralSkills.length
    ? state.centralSkills.map((c) => `<div class="row">
        <input type="checkbox" data-sel="central" data-name="${esc(c.name)}"${state.selCentral.has(c.name) ? ' checked' : ''}>
        <span class="name">${esc(c.name)}</span>
        <span class="desc">${esc(c.description)}</span>
        ${relationTag(c)}
        <span class="acts">
          <button class="btn small ghost" data-act="sync" data-name="${esc(c.name)}">同步到项目</button>
        </span>
      </div>`).join('')
    : '<div class="row muted">（中心仓库暂无 skill；中心根目录下直接放 skill 目录即可）</div>';
  $('#centralCount').textContent = state.centralSkills.length ? `${state.centralSkills.length} 个` : '';

  const pl = $('#projectList');
  pl.innerHTML = state.projectSkills.length
    ? state.projectSkills.map((s) => `<div class="row">
        <input type="checkbox" data-sel="project" data-name="${esc(s.name)}"${state.selProject.has(s.name) ? ' checked' : ''}>
        <span class="name">${esc(s.name)}</span>
        ${projectStateTag(s)}
        ${platformPills(s)}
        <span class="acts">
          <button class="btn small ghost" data-act="push" data-name="${esc(s.name)}">推送到中心</button>
          ${(s.platforms || []).some((p) => p.linkType) ? `<button class="btn small ghost" data-act="materialize" data-name="${esc(s.name)}">转实体</button>` : ''}
          <button class="btn small ghost danger" data-act="remove-skill" data-name="${esc(s.name)}">删除</button>
        </span>
      </div>`).join('')
    : '<div class="row muted">（项目侧暂无 skill；从中心同步，或勾选平台小按钮）</div>';
  $('#projectCount').textContent = state.projectSkills.length
    ? `${state.projectSkills.length} 个 · 默认平台 ${state.settings?.defaultPlatform || 'claude-code'}`
    : '';
}

async function loadSkills() {
  const central = $('#centralSelect').value;
  const project = $('#projectSelect').value;
  const [cs, ps] = await Promise.all([
    central ? api(`/api/skills?side=central&path=${encodeURIComponent(central)}`).catch(() => []) : Promise.resolve([]),
    project ? api(`/api/skills?side=project&path=${encodeURIComponent(project)}`).catch(() => []) : Promise.resolve([]),
  ]);
  state.centralSkills = cs;
  state.projectSkills = ps;
  state.selCentral = new Set([...state.selCentral].filter((n) => cs.some((x) => x.name === n)));
  state.selProject = new Set([...state.selProject].filter((n) => ps.some((x) => x.name === n)));
  renderSkills();
}

function renderSelectors() {
  const s = state.settings || {};
  const cList = s.skillCentralCandidates || [];
  $('#centralSelect').innerHTML = cList.length
    ? cList.map((p) => opt(p, p.replace(/^.*[\\/]/, '') + '  ·  ' + p, p === s.skillCentralPath)).join('')
    : opt('', '（请先添加中心仓库）', true);
  if (cList.length && s.skillCentralPath && cList.includes(s.skillCentralPath)) {
    $('#centralSelect').value = s.skillCentralPath;
  }

  // 项目候选 = 仓库登记（自动纳入） + 显式候选，去重
  const map = new Map();
  for (const r of state.repos) {
    map.set(r.path.toLowerCase(), { path: r.path, label: `${r.name}（仓库）  ·  ${r.path}` });
  }
  for (const p of s.skillProjectCandidates || []) {
    const k = p.toLowerCase();
    if (map.has(k)) map.get(k).label = map.get(k).label.replace('（仓库）', '（仓库+候选）');
    else map.set(k, { path: p, label: p.replace(/^.*[\\/]/, '') + '  ·  ' + p });
  }
  const merged = [...map.values()];
  $('#projectSelect').innerHTML = merged.length
    ? merged.map((o) => opt(o.path, o.label, false)).join('')
    : opt('', '（请先登记仓库或添加项目目录）', true);

  $('#bundledHint').textContent = state.bundled
    ? state.bundled.skills.map((x) => `${x.name}(${x.files})`).join(' ') + ' → ' + state.bundled.defaultDir
    : '';
}

$('#centralAdd').addEventListener('click', () => guard(async () => {
  const p = await askPrompt('中心仓库绝对路径（根目录下直接是 skill 目录）');
  if (!p) return;
  const list = await api('/api/candidates', { method: 'POST', body: { kind: 'central', path: p } });
  state.settings.skillCentralCandidates = list;
  state.settings.skillCentralPath = list[list.length - 1];
  await api('/api/settings', { method: 'POST', body: { skillCentralPath: state.settings.skillCentralPath } });
  renderSelectors();
  await loadSkills();
}));

$('#centralRemove').addEventListener('click', () => guard(async () => {
  const p = $('#centralSelect').value;
  if (!p) return;
  if (!(await askConfirm(`从候选移除中心仓库？\n${p}\n（仅移出列表，不动磁盘）`, true))) return;
  const list = await api('/api/candidates', { method: 'POST', body: { kind: 'central', path: p, remove: true } });
  state.settings.skillCentralCandidates = list;
  state.settings.skillCentralPath = list[0] || '';
  await api('/api/settings', { method: 'POST', body: { skillCentralPath: state.settings.skillCentralPath } });
  renderSelectors();
  await loadSkills();
}));

$('#projectAdd').addEventListener('click', () => guard(async () => {
  const p = await askPrompt('项目根目录绝对路径（已登记的仓库会自动出现在下拉里，也可另外添加）');
  if (!p) return;
  const list = await api('/api/candidates', { method: 'POST', body: { kind: 'project', path: p } });
  state.settings.skillProjectCandidates = list;
  renderSelectors();
  if (list.length) $('#projectSelect').value = list[list.length - 1];
  await loadSkills();
}));

$('#projectRemove').addEventListener('click', () => guard(async () => {
  const p = $('#projectSelect').value;
  if (!p) return;
  if (!(await askConfirm(`从候选移除项目目录？\n${p}`, true))) return;
  const list = await api('/api/candidates', { method: 'POST', body: { kind: 'project', path: p, remove: true } });
  state.settings.skillProjectCandidates = list;
  renderSelectors();
  await loadSkills();
}));

$('#centralSelect').addEventListener('change', () => guard(async () => {
  state.settings = await api('/api/settings', { method: 'POST', body: { skillCentralPath: $('#centralSelect').value } });
  await loadSkills();
}));
$('#projectSelect').addEventListener('change', () => guard(loadSkills));
$('#syncMode').addEventListener('change', () => guard(async () => {
  state.settings = await api('/api/settings', { method: 'POST', body: { skillSyncMode: $('#syncMode').value } });
  renderSettings();
}));
$('#defaultPlatform').addEventListener('change', () => guard(async () => {
  const id = $('#defaultPlatform').value;
  state.settings = await api('/api/settings', {
    method: 'POST',
    body: { defaultPlatform: id, platforms: [id, ...(state.settings.platforms || []).filter((x) => x !== id)] },
  });
  renderSettings();
  renderSkills();
  await loadSkills();
}));

$('#skillRefresh').addEventListener('click', () => guard(loadSkills));

// 行内勾选（用于比较）
function bindSelCheck(containerId) {
  $(containerId).addEventListener('change', (e) => {
    const cb = e.target.closest('input[data-sel]');
    if (!cb) return;
    const set = cb.dataset.sel === 'central' ? state.selCentral : state.selProject;
    if (cb.checked) set.add(cb.dataset.name); else set.delete(cb.dataset.name);
  });
}
bindSelCheck('#centralList');
bindSelCheck('#projectList');

// 平台小按钮：开 = 同步到该平台；关 = 移除该平台下的副本/链接。
// 链接可随意关闭（不影响实体锚点）；实体由服务端兜底：若会清零实体则返回 blocked。
async function togglePlatform(btn) {
  const project = $('#projectSelect').value;
  if (!project) { toast('请先选择项目目录'); return; }
  const turningOff = btn.dataset.on === '1';
  const name = btn.dataset.name;
  const body = { name, project, adapter: btn.dataset.adapter, enabled: !turningOff, force: false, mode: $('#syncMode').value };
  let r = await api('/api/skills/platform', { method: 'POST', body });
  if (r.status === 'conflict') {
    if (!(await askConfirm(`「${name}」在该平台已存在且内容不同（${r.files.length} 个文件）。\n用中心版本覆盖？`))) return;
    r = await api('/api/skills/platform', { method: 'POST', body: { ...body, force: true } });
  }
  if (r.status === 'conflict') { toast('仍有冲突，未覆盖'); return; }
  if (r.status === 'blocked') { toast(r.reason); return; }
  const anchorNote = r.anchor?.converted ? `\n已自动物化「${r.anchor.converted.name}」作为实体锚点` : '';
  if (r.removed) toast(`${r.platform}：已关闭${anchorNote}`);
  else if (r.skipped) toast(`${r.platform}：已是最新`);
  else toast(`${r.platform}：已开启（${r.mode === 'symlink' ? '软链接 ' + (r.linkType || '') : '复制'}）`);
  await loadSkills();
}

$('#projectList').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  if (btn.dataset.act === 'toggle-platform') return guard(() => togglePlatform(btn));
  const name = btn.dataset.name;
  const project = $('#projectSelect').value;
  guard(async () => {
    if (!project) { toast('请先选择项目目录'); return; }
    if (btn.dataset.act === 'push') {
      const r = await api('/api/skills/push', { method: 'POST', body: { name, project, force: false } });
      if (r.status === 'conflict') {
        toast(`冲突：${r.files.length} 个文件，打开差异选侧`);
        const detail = await api(`/api/skills/conflict?name=${encodeURIComponent(name)}&project=${encodeURIComponent(project)}`);
        conflictModal(name, project, detail);
      } else {
        toast(r.skipped ? r.reason : '已推送到中心');
      }
      await loadSkills();
    } else if (btn.dataset.act === 'materialize') {
      if (!(await askConfirm(`将「${name}」从链接转换为实体文件？转换后不再与中心实时同步。`))) return;
      const r = await api('/api/skills/materialize', { method: 'POST', body: { name, project } });
      toast(r.converted ? '已转换为实体文件' : r.message);
      await loadSkills();
    } else if (btn.dataset.act === 'remove-skill') {
      if (!(await askConfirm(`从项目中删除 skill「${name}」？\n将移除它在所有平台目录下的副本与链接（中心仓库不受影响）。`, true))) return;
      const r = await api('/api/skills/remove-project', { method: 'POST', body: { name, project } });
      const anchorNote2 = r.anchor?.converted ? `\n已自动物化「${r.anchor.converted.name}」作为实体锚点` : '';
      toast(r.removed.length ? `已删除（${r.removed.map((x) => x.platform).join(', ')}）${anchorNote2}` : r.reason);
      await loadSkills();
    }
  });
});

$('#centralList').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act="sync"]');
  if (!btn) return;
  const name = btn.dataset.name;
  const project = $('#projectSelect').value;
  guard(async () => {
    if (!project) { toast('请先选择项目目录'); return; }
    const adapter = $('#defaultPlatform').value;
    const r = await api('/api/skills/sync', {
      method: 'POST',
      body: { name, project, adapter, mode: $('#syncMode').value, force: false },
    });
    if (r.status === 'conflict') {
      toast(`冲突：${r.files.length} 个文件，打开差异选侧`);
      const detail = await api(`/api/skills/conflict?name=${encodeURIComponent(name)}&project=${encodeURIComponent(project)}`);
      conflictModal(name, project, detail);
    } else if (r.skipped) {
      toast(`已是最新（${r.linkType || '链接'}），跳过`);
    } else {
      toast(`已同步到 ${adapter}（${r.mode === 'symlink' ? '软链接 ' + (r.linkType || '') : '复制'}）`);
    }
    await loadSkills();
  });
});

// 比较选中（两侧勾选的并集；未勾选则全量）
$('#skillCompare').addEventListener('click', () => guard(async () => {
  const central = $('#centralSelect').value;
  const project = $('#projectSelect').value;
  if (!project) { toast('请先选择项目目录'); return; }
  const names = [...new Set([...state.selCentral, ...state.selProject])];
  const d = await api('/api/skills/compare', { method: 'POST', body: { central, project, names } });
  const mark = { same: '一致', linked: '链接', differ: '冲突', 'only-central': '仅中心', 'only-project': '仅项目' };
  const s = d.summary;
  $('#compareSummary').textContent =
    `共 ${s.total} · 一致 ${s.same} · 链接 ${s.linked} · 冲突 ${s.differ} · 仅中心 ${s.onlyCentral} · 仅项目 ${s.onlyProject}`;
  $('#compareRows').innerHTML = d.rows.length
    ? d.rows.map((r) => `<div class="row">
        <span class="name">${esc(r.name)}</span>
        <span class="desc">${esc(r.description)}</span>
        ${r.platforms.length ? `<span class="plats">${r.platforms.map((p) => `<span class="pill on">${esc(shortLabel(p.id))}</span>`).join('')}</span>` : ''}
        <span class="acts">
          <span class="tag${r.state === 'differ' ? ' bad' : r.state === 'same' || r.state === 'linked' ? ' strong' : ''}">${mark[r.state]}</span>
          ${r.state === 'differ' ? `<button class="btn small ghost" data-act="detail" data-name="${esc(r.name)}">差异</button>` : ''}
        </span>
      </div>`).join('')
    : '<div class="row muted">（没有可比较的 skill）</div>';
  $('#compareBox').classList.remove('hidden');
}));

$('#compareRows').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act="detail"]');
  if (!btn) return;
  const project = $('#projectSelect').value;
  guard(async () => {
    const detail = await api(`/api/skills/conflict?name=${encodeURIComponent(btn.dataset.name)}&project=${encodeURIComponent(project)}`);
    conflictModal(btn.dataset.name, project, detail);
  });
});

// 冲突详情弹窗（按文件选侧）
function conflictModal(name, project, data) {
  const wrap = document.createElement('div');
  if (!data.files.length) wrap.appendChild(document.createTextNode('两侧一致，无差异'));
  for (const f of data.files) {
    const box = document.createElement('div');
    box.className = 'conflict-file';
    const head = document.createElement('div');
    head.className = 'cf-head';
    const label = document.createElement('span');
    label.textContent = `${f.file} (${f.side})`;
    const actions = document.createElement('span');
    if (f.side === 'both-differ') {
      const bCentral = document.createElement('button');
      bCentral.className = 'btn small';
      bCentral.textContent = '用中心版';
      bCentral.onclick = () => guard(async () => {
        await api('/api/skills/apply', { method: 'POST', body: { name, project, file: f.file, side: 'central' } });
        bCentral.disabled = true;
        await loadSkills();
      });
      const bProject = document.createElement('button');
      bProject.className = 'btn small ghost';
      bProject.textContent = '用项目版';
      bProject.style.marginLeft = '6px';
      bProject.onclick = () => guard(async () => {
        await api('/api/skills/apply', { method: 'POST', body: { name, project, file: f.file, side: 'project' } });
        bProject.disabled = true;
        await loadSkills();
      });
      actions.append(bCentral, bProject);
    }
    head.append(label, actions);
    box.appendChild(head);
    if (f.diff) box.appendChild(preNode(f.diff));
    wrap.appendChild(box);
  }
  openModal(`冲突详情 · ${name}`, wrap);
}

// 内置 skill 安装
$('#bundledInstall').addEventListener('click', () => guard(async () => {
  const skill = state.bundled?.skills.find((s) => s.name === 'repo-hub') || state.bundled?.skills[0];
  if (!skill) { toast('包内没有内置 skill'); return; }
  const r = await api('/api/bundled/install', { method: 'POST', body: { name: skill.name, force: false } });
  if (r.status === 'conflict') {
    if (!(await askConfirm(`目标已存在且内容不同（${r.count} 个文件）:\n${r.path}\n\n覆盖为包内版本？`))) return;
    const forced = await api('/api/bundled/install', { method: 'POST', body: { name: skill.name, force: true } });
    toast(`${forced.replaced ? '已更新' : '已安装'} → ${forced.path}`);
  } else if (r.skipped) {
    toast(`已是最新，无需安装\n${r.path}`);
  } else {
    toast(`${r.replaced ? '已更新' : '已安装'}（${r.files} 个文件）\n${r.path}`);
  }
}));

// ================= 设置页 =================

function candidateRows(list, kind) {
  return list.length
    ? list.map((p) => `<div class="row">
        <span class="mono">${esc(p)}</span>
        <span class="acts"><button class="btn small ghost" data-act="rm-cand" data-kind="${kind}" data-path="${esc(p)}">移除</button></span>
      </div>`).join('')
    : '<div class="row muted">（暂无；已登记的仓库会自动作为项目候选）</div>';
}

// 平台范围：三层中的第二层——在全部适配器里勾选要支持的平台
function renderPlatformScope() {
  const s = state.settings || {};
  const scope = new Set(s.platforms || []);
  const box = $('#setPlatformsBox');
  box.innerHTML = state.adapters
    .map((a) => `<button class="pill${scope.has(a.id) ? ' on' : ''}" data-platform="${esc(a.id)}">${esc(shortLabel(a.id))}</button>`)
    .join('');
  const def = s.defaultPlatform || 'claude-code';
  const defOpts = (scope.size ? [...scope] : ['claude-code'])
    .map((id) => opt(id, (state.adapters.find((a) => a.id === id) || {}).name || id, id === def))
    .join('');
  // 两处下拉都要填充：设置页 + Skill 页工具栏（0.4.1 漏了后者导致 Skill 页下拉为空）
  $('#setDefaultPlatform').innerHTML = defOpts;
  $('#defaultPlatform').innerHTML = defOpts;
  box.onclick = async (e) => {
    const btn = e.target.closest('button[data-platform]');
    if (!btn) return;
    const id = btn.dataset.platform;
    let next = scope.has(id) ? [...scope].filter((x) => x !== id) : [...scope, id];
    if (!next.length) { toast('平台范围至少保留一个'); return; }
    if (!next.includes(s.defaultPlatform)) s.defaultPlatform = next[0]; // 默认平台必须留在范围内
    state.settings = await api('/api/settings', {
      method: 'POST',
      body: { platforms: next, defaultPlatform: s.defaultPlatform },
    });
    renderPlatformScope();
    renderSelectors();
    renderSkills();
  };
}

function renderSettings() {
  const s = state.settings || {};
  $('#setCentralList').innerHTML = candidateRows(s.skillCentralCandidates || [], 'central');
  $('#setProjectList').innerHTML = candidateRows(s.skillProjectCandidates || [], 'project');
  renderPlatformScope();
  $('#setSyncMode').value = s.skillSyncMode === 'copy' ? 'copy' : 'symlink';
  $('#syncMode').value = s.skillSyncMode === 'copy' ? 'copy' : 'symlink';
  $('#setAdapters').textContent = state.adapters.map((a) => `${a.id} = ${a.dir}`).join('   ');
  $('#setStore').textContent = state.storePath;
}

$('#setCentralAdd').addEventListener('click', () => guard(async () => {
  const p = $('#setCentralInput').value.trim();
  if (!p) { toast('请输入中心仓库路径'); return; }
  const list = await api('/api/candidates', { method: 'POST', body: { kind: 'central', path: p } });
  state.settings.skillCentralCandidates = list;
  state.settings.skillCentralPath = list[list.length - 1];
  await api('/api/settings', { method: 'POST', body: { skillCentralPath: state.settings.skillCentralPath } });
  $('#setCentralInput').value = '';
  renderSelectors(); renderSettings(); await loadSkills();
}));

$('#setProjectAdd').addEventListener('click', () => guard(async () => {
  const p = $('#setProjectInput').value.trim();
  if (!p) { toast('请输入项目根目录'); return; }
  const list = await api('/api/candidates', { method: 'POST', body: { kind: 'project', path: p } });
  state.settings.skillProjectCandidates = list;
  $('#setProjectInput').value = '';
  renderSelectors(); renderSettings();
}));

$('#setSyncMode').addEventListener('change', () => guard(async () => {
  state.settings = await api('/api/settings', { method: 'POST', body: { skillSyncMode: $('#setSyncMode').value } });
  renderSettings();
}));
$('#setDefaultPlatform').addEventListener('change', () => guard(async () => {
  const id = $('#setDefaultPlatform').value;
  state.settings = await api('/api/settings', {
    method: 'POST',
    body: { defaultPlatform: id, platforms: [id, ...(state.settings.platforms || []).filter((x) => x !== id)] },
  });
  renderPlatformScope(); renderSelectors(); renderSkills(); await loadSkills();
}));

document.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act="rm-cand"]');
  if (!btn) return;
  guard(async () => {
    const { kind, path } = btn.dataset;
    if (!(await askConfirm(`移除候选？\n${path}`, true))) return;
    const list = await api('/api/candidates', { method: 'POST', body: { kind, path, remove: true } });
    if (kind === 'central') {
      state.settings.skillCentralCandidates = list;
      if (state.settings.skillCentralPath === path) {
        state.settings.skillCentralPath = list[0] || '';
        await api('/api/settings', { method: 'POST', body: { skillCentralPath: state.settings.skillCentralPath } });
      }
    } else {
      state.settings.skillProjectCandidates = list;
    }
    renderSelectors(); renderSettings(); await loadSkills();
  });
});

// ================= GitHub 连接器 =================

async function loadGhStatus() {
  try {
    const s = await api('/api/gh/status');
    $('#ghStatus').textContent = s.available ? 'gh 已登录' : 'gh 未就绪';
    $('#ghStatus').style.color = s.available ? '' : '#c00';
  } catch (e) {
    $('#ghStatus').textContent = 'gh 检查失败';
  }
}

function renderGhOverview(r) {
  const box = $('#ghOverview');
  box.classList.remove('hidden');
  $('#ghResults').classList.add('hidden');
  const badge = [];
  if (r.isPrivate) badge.push('private');
  if (r.isArchived) badge.push('archived');
  if (r.isFork) badge.push('fork');
  const topics = r.topics && r.topics.length ? '<div class="muted" style="margin-top:6px">主题: ' + esc(r.topics.join(', ')) + '</div>' : '';
  box.innerHTML = `
    <div class="colhead">
      <h3><a href="${esc(r.url)}" target="_blank">${esc(r.nameWithOwner)}</a> ${badge.length ? '<span class="muted">' + badge.join(' ') + '</span>' : ''}</h3>
      <span class="muted">${esc(r.primaryLanguage || '-')}</span>
    </div>
    <div style="padding:12px 16px">
      <div style="margin-bottom:8px">${esc(r.description || '（无描述）')}</div>
      <div class="settings">
        <dt>Stars</dt><dd>${r.stargazersCount}</dd>
        <dt>Forks</dt><dd>${r.forkCount}</dd>
        <dt>Watchers</dt><dd>${r.watchers}</dd>
        <dt>Open Issues</dt><dd>${r.openIssues}</dd>
        <dt>Open PRs</dt><dd>${r.pullRequests}</dd>
        <dt>默认分支</dt><dd>${esc(r.defaultBranch || '-')}</dd>
        <dt>License</dt><dd>${esc(r.license || '-')}</dd>
        <dt>最新版本</dt><dd>${esc(r.latestRelease || '-')}</dd>
        <dt>创建时间</dt><dd>${esc(String(r.createdAt || '').slice(0, 10))}</dd>
        <dt>更新时间</dt><dd>${esc(String(r.updatedAt || '').slice(0, 10))}</dd>
        <dt>推送时间</dt><dd>${esc(String(r.pushedAt || '').slice(0, 10))}</dd>
        <dt>语言</dt><dd>${esc((r.languages || []).join(', ') || r.primaryLanguage || '-')}</dd>
        ${r.homepageUrl ? '<dt>主页</dt><dd><a href="' + esc(r.homepageUrl) + '" target="_blank">' + esc(r.homepageUrl) + '</a></dd>' : ''}
      </div>
      ${topics}
    </div>`;
}

function renderGhResults(list) {
  const box = $('#ghResults');
  box.classList.remove('hidden');
  $('#ghOverview').classList.add('hidden');
  const tbody = box.querySelector('tbody');
  tbody.innerHTML = list.map((r) => `
    <tr>
      <td>${r.stargazersCount}</td>
      <td>${esc(r.primaryLanguage || '-')}</td>
      <td><a href="${esc(r.url)}" target="_blank" data-repo="${esc(r.nameWithOwner)}" class="gh-repo-link">${esc(r.nameWithOwner)}</a></td>
      <td>${esc(r.description || '').slice(0, 60)}</td>
      <td>${esc(String(r.updatedAt || '').slice(0, 10))}</td>
    </tr>`).join('');
}

$('#ghViewBtn').addEventListener('click', () => guard(async () => {
  const repo = $('#ghRepoInput').value.trim();
  if (!repo) { toast('请输入 owner/repo'); return; }
  const r = await api('/api/gh/view?repo=' + encodeURIComponent(repo));
  renderGhOverview(r);
}));

$('#ghRepoInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#ghViewBtn').click();
});

$('#ghSearchBtn').addEventListener('click', () => guard(async () => {
  const q = $('#ghSearchInput').value.trim();
  if (!q) { toast('请输入搜索关键词'); return; }
  const limit = parseInt($('#ghSearchLimit').value, 10) || 10;
  const list = await api('/api/gh/search?q=' + encodeURIComponent(q) + '&limit=' + limit);
  renderGhResults(list);
}));

$('#ghSearchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#ghSearchBtn').click();
});

$('#ghMineBtn').addEventListener('click', () => guard(async () => {
  const list = await api('/api/gh/mine?limit=30');
  renderGhResults(list);
}));

// 点击搜索结果中的仓库名直接查看概览
document.addEventListener('click', (e) => {
  const link = e.target.closest('.gh-repo-link');
  if (!link) return;
  e.preventDefault();
  guard(async () => {
    const repo = link.dataset.repo;
    $('#ghRepoInput').value = repo;
    const r = await api('/api/gh/view?repo=' + encodeURIComponent(repo));
    renderGhOverview(r);
  });
});

// ================= 启动 =================

(async () => {
  const boot = await api('/api/bootstrap');
  state.settings = boot.settings;
  state.adapters = boot.adapters;
  state.storePath = boot.storePath;
  state.repos = boot.repos;
  state.bundled = await api('/api/bundled').catch(() => null);

  $('#storePath').textContent = state.storePath;
  renderRepos();
  renderSelectors();
  renderSettings();
  await loadSkills();
})();
