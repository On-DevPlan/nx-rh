// 设置页：中心/项目候选管理、平台范围、同步模式、适配器总表。
import { useState } from 'react';
import { api } from '../api/client.js';
import { useStore } from '../store.jsx';
import { useToast, useGuard, useDialog } from '../components/ui.jsx';

function shortLabel(adapterId, adapters) {
  const a = adapters.find((x) => x.id === adapterId);
  return (a ? a.name : adapterId).replace(/\s*\(.*\)$/, '').split(/[\s-]/)[0].toLowerCase();
}

export default function SettingsView() {
  const { boot, ui, patchUi, refreshBoot } = useStore();
  const toast = useToast();
  const guard = useGuard();
  const { dialog, node: dialogNode } = useDialog();
  const [centralInput, setCentralInput] = useState('');
  const [projectInput, setProjectInput] = useState('');

  const settings = boot?.settings || {};
  const adapters = boot?.adapters || [];

  const addCandidate = (kind) => guard(async () => {
    const p = (kind === 'central' ? centralInput : projectInput).trim();
    if (!p) { toast(kind === 'central' ? '请输入中心仓库路径' : '请输入项目根目录'); return; }
    const list = await api('/api/candidates', { method: 'POST', body: { kind, path: p } });
    if (kind === 'central') {
      setCentralInput('');
      await api('/api/settings', { method: 'POST', body: { skillCentralPath: list[list.length - 1] } });
      patchUi({ central: list[list.length - 1] || ui.central });
    } else {
      setProjectInput('');
    }
    await refreshBoot();
  });

  const removeCandidate = (kind, path) => guard(async () => {
    const ok = await dialog({ message: `移除候选？\n${path}`, danger: true });
    if (!ok) return;
    const list = await api('/api/candidates', { method: 'POST', body: { kind, path, remove: true } });
    if (kind === 'central' && settings.skillCentralPath === path) {
      await api('/api/settings', { method: 'POST', body: { skillCentralPath: list[0] || '' } });
      patchUi({ central: list[0] || '' });
    }
    await refreshBoot();
  });

  // 平台范围 pill：勾选 = 纳入默认支持范围；默认平台必须留在范围内，范围至少一个
  const togglePlatformScope = (id) => guard(async () => {
    const scope = new Set(settings.platforms || []);
    const next = scope.has(id) ? [...scope].filter((x) => x !== id) : [...scope, id];
    if (!next.length) { toast('平台范围至少保留一个'); return; }
    let def = settings.defaultPlatform;
    if (!next.includes(def)) def = next[0];
    await api('/api/settings', { method: 'POST', body: { platforms: next, defaultPlatform: def } });
    await refreshBoot();
  });

  const setSyncMode = (mode) => guard(async () => {
    await api('/api/settings', { method: 'POST', body: { skillSyncMode: mode } });
    await refreshBoot();
  });

  const setDefaultPlatform = (id) => guard(async () => {
    await api('/api/settings', {
      method: 'POST',
      body: { defaultPlatform: id, platforms: [id, ...(settings.platforms || []).filter((x) => x !== id)] },
    });
    await refreshBoot();
  });

  const scope = new Set(settings.platforms || []);
  const defOpts = (scope.size ? [...scope] : ['claude-code']);

  const candidateRows = (list, kind) => list.length ? list.map((p) => (
    <div key={p} className="row">
      <span className="mono">{p}</span>
      <span className="acts">
        <button className="btn small ghost" onClick={() => removeCandidate(kind, p)}>移除</button>
      </span>
    </div>
  )) : <div className="row muted">（暂无；已登记的仓库会自动作为项目候选）</div>;

  return (
    <>
      <div className="cols">
        <div className="col">
          <div className="card">
            <div className="colhead"><h3>中心仓库候选</h3><span className="muted">根目录下直接是 skill</span></div>
            <div className="list">{candidateRows(settings.skillCentralCandidates || [], 'central')}</div>
            <div className="row-inline">
              <input placeholder="中心仓库路径" spellCheck="false" value={centralInput}
                onChange={(e) => setCentralInput(e.target.value)} />
              <button className="btn" onClick={() => addCandidate('central')}>添加</button>
            </div>
          </div>
        </div>
        <div className="col">
          <div className="card">
            <div className="colhead"><h3>项目目录候选</h3><span className="muted">按平台（适配器）识别</span></div>
            <div className="list">{candidateRows(settings.skillProjectCandidates || [], 'project')}</div>
            <div className="row-inline">
              <input placeholder="项目根目录" spellCheck="false" value={projectInput}
                onChange={(e) => setProjectInput(e.target.value)} />
              <button className="btn" onClick={() => addCandidate('project')}>添加</button>
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="colhead"><h3>平台与同步</h3></div>
        <div className="settings">
          <dt>默认平台</dt>
          <dd>
            <select value={settings.defaultPlatform || 'claude-code'} onChange={(e) => setDefaultPlatform(e.target.value)}>
              {defOpts.map((id) => (
                <option key={id} value={id}>{(adapters.find((a) => a.id === id) || {}).name || id}</option>
              ))}
            </select>
          </dd>
          <dt>平台范围</dt>
          <dd>
            <span className="plats">
              {adapters.map((a) => (
                <button key={a.id} className={'pill' + (scope.has(a.id) ? ' on' : '')} onClick={() => togglePlatformScope(a.id)}>
                  {shortLabel(a.id, adapters)}
                </button>
              ))}
            </span>
          </dd>
          <dt>同步模式</dt>
          <dd>
            <select value={settings.skillSyncMode === 'copy' ? 'copy' : 'symlink'} onChange={(e) => setSyncMode(e.target.value)}>
              <option value="symlink">软链接</option>
              <option value="copy">复制</option>
            </select>
          </dd>
          <dt>适配器总表</dt><dd className="mono">{adapters.map((a) => `${a.id} = ${a.dir}`).join('   ')}</dd>
          <dt>存储文件</dt><dd className="mono">{boot?.storePath}</dd>
          <dt>面板端口</dt><dd>默认 7800（<code>nx-rh serve --port</code> 可改，仅绑定 127.0.0.1）</dd>
        </div>
      </div>
      {dialogNode}
    </>
  );
}
