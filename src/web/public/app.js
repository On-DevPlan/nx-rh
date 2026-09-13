// nx-rh 面板逻辑：全部操作走 /api，与 CLI 共享同一 service 层。
// 约定：无 emoji、原生 confirm/alert 作为提示通道。
const $ = (s, el = document) => el.querySelector(s);

const state = {
  settings: null,
  adapters: [],
  storePath: '',
  repos: [],
  statuses: [],
  centralSkills: [],
  projectSkills: [],
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

function notify(msg) { window.alert(msg); }

async function guard(fn) {
  try { return await fn(); } catch (e) { notify(String(e && e.message || e)); }
}

// ---- 标签页 ----
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + btn.dataset.tab));
  });
});

// ---- 弹窗 ----
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
  // 逐行着色：+ 加粗灰底，- 删除线
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

// ================= 仓库页 =================

function statusCell(g) {
  if (!g) return '<span class="muted">未刷新</span>';
  if (g.error) return '<span class="muted">非 git 仓库</span>';
  if (g.conflicted.length) return `<span class="bad">冲突 ${g.conflicted.length} 文件</span>`;
  if (g.clean) return '干净';
  const changed = g.staged.length + g.modified.length + g.untracked.length;
  return `${g.ahead > 0 ? '领先' + g.ahead + ' ' : ''}${g.behind > 0 ? '落后' + g.behind + ' ' : ''}变更 ${changed} 未跟踪 ${g.untracked.length}`;
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
        <td>${esc(r.name)}</td>
        <td class="path">${esc(r.path)}</td>
        <td>${r.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</td>
        <td class="path">${esc(g?.branch || '-')}</td>
        <td>${statusCell(g)}</td>
        <td class="ops">
          <button class="btn small" data-act="diff" data-id="${esc(r.id)}">diff</button>
          <button class="btn small" data-act="pull" data-id="${esc(r.id)}">pull</button>
          <button class="btn small" data-act="push" data-id="${esc(r.id)}">push</button>
          <button class="btn small" data-act="open" data-id="${esc(r.id)}">打开目录</button>
          <button class="btn small" data-act="copy" data-path="${esc(r.path)}">复制路径</button>
          <button class="btn small" data-act="del" data-id="${esc(r.id)}" data-name="${esc(r.name)}">删除</button>
        </td>
      </tr>`;
    })
    .join('');
}

async function loadRepos() {
  state.repos = await api('/api/repos');
  renderRepos();
}

async function refreshStatuses() {
  state.statuses = await api('/api/repos/status');
  renderRepos();
}

$('#repoAdd').addEventListener('click', () => guard(async () => {
  const path = $('#repoPath').value.trim();
  if (!path) return notify('请输入仓库路径');
  await api('/api/repos', {
    method: 'POST',
    body: { path, name: $('#repoName').value.trim() || undefined, tags: $('#repoTags').value.trim() || undefined },
  });
  $('#repoPath').value = ''; $('#repoName').value = ''; $('#repoTags').value = '';
  await loadRepos();
}));

$('#repoScan').addEventListener('click', () => guard(async () => {
  const root = $('#scanRoot').value.trim();
  if (!root) return notify('请输入扫描根目录');
  const r = await api('/api/repos/scan', { method: 'POST', body: { root, depth: parseInt($('#scanDepth').value, 10) || 3 } });
  notify(`扫描完成：发现 ${r.scanned} 个 git 仓库，新登记 ${r.added.length} 个`);
  await loadRepos();
}));

$('#repoRefresh').addEventListener('click', () => guard(refreshStatuses));

$('#repoTable').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const id = btn.dataset.id;
  guard(async () => {
    if (act === 'diff') {
      const text = await api(`/api/repos/diff?id=${encodeURIComponent(id)}`);
      openModal('diff', preNode(text));
    } else if (act === 'pull') {
      const r = await api('/api/repos/pull', { method: 'POST', body: { id } });
      let text = r.output || '(无输出)';
      if (r.conflicted && r.conflicted.length) {
        text += '\n\n冲突文件（可用 CLI 逐个落地）:\n' + r.conflicted.map((f) => `  nx-rh repo resolve ${id} --file "${f}" --side ours|theirs`).join('\n');
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
      try { await navigator.clipboard.writeText(btn.dataset.path); } catch { notify('复制失败: ' + btn.dataset.path); }
    } else if (act === 'del') {
      if (!confirm(`删除仓库登记「${btn.dataset.name}」？\n（仅移除登记，磁盘文件不受影响）`)) return;
      await api(`/api/repos/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await loadRepos();
    }
  });
});

// ================= Skill 页 =================

function centralRelation(c) {
  const proj = state.projectSkills.find((s) => s.name === c.name);
  if (!proj) return '<span class="muted">项目无</span>';
  if (proj.linkType) return `链接·${proj.linkType}`;
  if (proj.md5 === c.md5) return '一致';
  return '<span class="bad">冲突</span>';
}

function renderSkills() {
  const ct = $('#centralTable tbody');
  ct.innerHTML = state.centralSkills.length
    ? state.centralSkills.map((c) => `<tr>
        <td>${esc(c.name)}</td>
        <td class="path">${esc(c.description)}</td>
        <td>${centralRelation(c)}</td>
        <td class="ops">
          <button class="btn small" data-act="sync" data-name="${esc(c.name)}">同步到项目</button>
          ${centralRelation(c).includes('冲突') ? `<button class="btn small" data-act="conflict" data-name="${esc(c.name)}">冲突详情</button>` : ''}
        </td>
      </tr>`).join('')
    : '<tr><td colspan="4" class="muted">（中心仓库暂无 skill）</td></tr>';

  const pt = $('#projectTable tbody');
  pt.innerHTML = state.projectSkills.length
    ? state.projectSkills.map((s) => `<tr>
        <td>${esc(s.name)}</td>
        <td class="path">${esc(s.description)}</td>
        <td>${s.linkType ? `链接·${s.linkType}` : '实体'} <span class="muted">${esc(s.adapter || '')}</span></td>
        <td class="ops">
          ${s.linkType ? `<button class="btn small" data-act="materialize" data-name="${esc(s.name)}">转换为实体</button>` : ''}
          ${!s.linkType ? `<button class="btn small" data-act="push" data-name="${esc(s.name)}">推送到中心</button>` : ''}
        </td>
      </tr>`).join('')
    : '<tr><td colspan="4" class="muted">（项目侧暂无 skill）</td></tr>';
}

async function loadSkills() {
  const centralOk = !!state.settings?.skillCentralPath;
  const project = $('#projectPath').value.trim();
  const [central, proj] = await Promise.all([
    centralOk ? api('/api/skills?side=central').catch(() => []) : Promise.resolve([]),
    project ? api(`/api/skills?side=project&path=${encodeURIComponent(project)}`).catch(() => []) : Promise.resolve([]),
  ]);
  state.centralSkills = central;
  state.projectSkills = proj;
  renderSkills();
}

$('#centralSave').addEventListener('click', () => guard(async () => {
  const p = $('#centralPath').value.trim();
  if (!p) return notify('请输入中心仓库路径');
  state.settings = await api('/api/settings', { method: 'POST', body: { skillCentralPath: p } });
  notify('中心仓库已保存: ' + state.settings.skillCentralPath);
  await loadSkills();
}));

$('#syncMode').addEventListener('change', () => guard(async () => {
  state.settings = await api('/api/settings', { method: 'POST', body: { skillSyncMode: $('#syncMode').value } });
}));

$('#skillScan').addEventListener('click', () => guard(async () => {
  if (!$('#projectPath').value.trim() && !state.settings?.skillCentralPath) return notify('请先填写中心仓库与项目目录');
  await loadSkills();
}));

// 冲突详情弹窗（含按文件选侧）
function conflictModal(name, project, data) {
  const wrap = document.createElement('div');
  if (!data.files.length) {
    wrap.appendChild(document.createTextNode('两侧一致，无差异'));
  }
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
      bProject.className = 'btn small';
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

$('#centralTable').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const name = btn.dataset.name;
  const project = $('#projectPath').value.trim();
  guard(async () => {
    if (!project) return notify('请先在上方填写项目目录');
    if (btn.dataset.act === 'sync') {
      const r = await api('/api/skills/sync', {
        method: 'POST',
        body: { name, project, mode: $('#syncMode').value, force: false },
      });
      if (r.status === 'conflict') {
        notify(`冲突：${r.files.length} 个文件不一致，打开冲突详情`);
        const detail = await api(`/api/skills/conflict?name=${encodeURIComponent(name)}&project=${encodeURIComponent(project)}`);
        conflictModal(name, project, detail);
      } else if (r.skipped) {
        notify('已是链接，无需同步');
      } else {
        notify(`已同步（${r.mode === 'symlink' ? '软链接 ' + (r.linkType || '') : '复制'}）`);
      }
      await loadSkills();
    } else if (btn.dataset.act === 'conflict') {
      const detail = await api(`/api/skills/conflict?name=${encodeURIComponent(name)}&project=${encodeURIComponent(project)}`);
      conflictModal(name, project, detail);
    }
  });
});

$('#projectTable').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const name = btn.dataset.name;
  const project = $('#projectPath').value.trim();
  guard(async () => {
    if (btn.dataset.act === 'materialize') {
      if (!confirm(`将「${name}」从链接转换为实体文件？\n转换后不再与中心仓库实时同步。`)) return;
      const r = await api('/api/skills/materialize', { method: 'POST', body: { name, project } });
      notify(r.converted ? '已转换为实体文件' : r.message);
      await loadSkills();
    } else if (btn.dataset.act === 'push') {
      const r = await api('/api/skills/push', { method: 'POST', body: { name, project, force: false } });
      if (r.status === 'conflict') {
        notify(`冲突：${r.files.length} 个文件，打开冲突详情选侧`);
        const detail = await api(`/api/skills/conflict?name=${encodeURIComponent(name)}&project=${encodeURIComponent(project)}`);
        conflictModal(name, project, detail);
      } else {
        notify(r.skipped ? r.reason : '已推送到中心');
      }
      await loadSkills();
    }
  });
});

// ================= 内置 skill 安装 =================

$('#bundledInstall').addEventListener('click', () => guard(async () => {
  const info = await api('/api/bundled');
  const skill = info.skills.find((s) => s.name === 'repo-hub') || info.skills[0];
  if (!skill) return notify('包内没有内置 skill');
  const r = await api('/api/bundled/install', { method: 'POST', body: { name: skill.name, force: false } });
  if (r.status === 'conflict') {
    if (!confirm(`目标已存在且内容不同（${r.count} 个文件）:\n${r.path}\n\n覆盖为包内版本？`)) return;
    const forced = await api('/api/bundled/install', { method: 'POST', body: { name: skill.name, force: true } });
    notify(`${forced.replaced ? '已更新' : '已安装'} → ${forced.path}`);
  } else if (r.skipped) {
    notify(`已是最新，无需安装\n${r.path}`);
  } else {
    notify(`${r.replaced ? '已更新' : '已安装'}（${r.files} 个文件）\n${r.path}`);
  }
  await loadBundledHint();
}));

async function loadBundledHint() {
  const info = await api('/api/bundled').catch(() => null);
  if (!info) return;
  const s = info.skills.find((x) => x.name === 'repo-hub');
  $('#bundledHint').textContent = s ? `${s.name}（${s.files} 个文件）→ ${info.defaultDir}` : '';
}

// ================= 设置页 =================
function renderSettings() {
  $('#setStore').textContent = state.storePath;
  $('#setCentral').textContent = state.settings?.skillCentralPath || '（未设置）';
  $('#setMode').textContent = state.settings?.skillSyncMode || 'symlink';
  $('#setAdapters').textContent = state.adapters.map((a) => a.dir).join('  ');
}

// ================= 启动 =================

(async () => {
  const boot = await api('/api/bootstrap');
  state.settings = boot.settings;
  state.adapters = boot.adapters;
  state.storePath = boot.storePath;
  state.repos = boot.repos;
  $('#storePath').textContent = state.storePath;
  $('#centralPath').value = state.settings.skillCentralPath || '';
  $('#syncMode').value = state.settings.skillSyncMode === 'copy' ? 'copy' : 'symlink';
  renderRepos();
  renderSettings();
  loadBundledHint();
})();
