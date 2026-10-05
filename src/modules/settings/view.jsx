// 设置页：订阅源 / 项目目录候选管理、平台范围、迁移形态、适配器总表。
import { useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { useStore } from '../../web/frontend/store.jsx';
import { useToast, useGuard, useDialog, Copyable } from '../../web/frontend/components/ui.jsx';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';

function shortLabel(adapterId, adapters) {
  const a = adapters.find((x) => x.id === adapterId);
  return (a ? a.name : adapterId).replace(/\s*\(.*\)$/, '').split(/[\s-]/)[0].toLowerCase();
}

// kind → API 路径：订阅源与项目目录用的是两套端点
const ENDPOINT = { hub: '/api/skills/sources', project: '/api/skills/project' };

export default function SettingsView() {
  const { boot, patchUi, refreshBoot } = useStore();
  const toast = useToast();
  const guard = useGuard();
  const { dialog, node: dialogNode } = useDialog();
  const [hubInput, setHubInput] = useState('');
  const [projectInput, setProjectInput] = useState('');

  const settings = boot?.settings || {};
  const adapters = boot?.adapters || [];

  const addCandidate = (kind) => guard(async () => {
    const p = (kind === 'hub' ? hubInput : projectInput).trim();
    if (!p) { toast(kind === 'hub' ? '请输入订阅源目录' : '请输入项目根目录'); return; }
    await api(ENDPOINT[kind], { method: 'POST', body: { path: p } });
    if (kind === 'hub') { setHubInput(''); patchUi({ source: '' }); }
    else setProjectInput('');
    await refreshBoot();
  });

  const removeCandidate = (kind, path) => guard(async () => {
    const ok = await dialog({ message: `移除候选？\n${path}`, danger: true });
    if (!ok) return;
    await api(ENDPOINT[kind], { method: 'DELETE', body: { path } });
    if (kind === 'hub' && settings.skillHubPath === path) patchUi({ source: '' });
    await refreshBoot();
  });

  // 平台范围 pill：默认平台必须留在范围内，范围至少一个
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
      <Copyable className="mono" text={p}>{p}</Copyable>
      {kind === 'hub' && settings.skillHubPath === p ? <span className="tag strong">当前主源</span> : null}
      <span className="acts">
        <button className="btn small ghost" onClick={() => removeCandidate(kind, p)}>移除</button>
      </span>
    </div>
  )) : <div className="row muted">（暂无）</div>;

  return (
    <>
      <div className="page-head">
        <div className="title-block">
          <h2>设置</h2>
          <div className="page-desc">
            管理订阅源与项目目录候选、平台范围、迁移形态，以及适配器与存储位置。
          </div>
        </div>
      </div>

      <div className="cols">
        <div className="col">
          <div className="card">
            <div className="colhead"><h3>订阅源（Skill Hub）</h3></div>
            <div className="vlegend">目录下直接是各 skill；订阅源是唯一可信源。</div>
            <div className="list">{candidateRows(settings.skillHubSources || [], 'hub')}</div>
            <div className="row-inline" style={{ padding: 10 }}>
              <input aria-label="skill 目录绝对路径" placeholder="skill 目录绝对路径" spellCheck="false" value={hubInput}
                onChange={(e) => setHubInput(e.target.value)} />
              <button className="btn" onClick={() => addCandidate('hub')}>订阅</button>
            </div>
          </div>
        </div>
        <div className="col">
          <div className="card">
            <div className="colhead"><h3>项目目录候选</h3></div>
            <div className="vlegend">迁移目标所在的仓库根。</div>
            <div className="list">{candidateRows(settings.skillProjectCandidates || [], 'project')}</div>
            <div className="row-inline" style={{ padding: 10 }}>
              <input aria-label="项目根目录" placeholder="项目根目录" spellCheck="false" value={projectInput}
                onChange={(e) => setProjectInput(e.target.value)} />
              <button className="btn" onClick={() => addCandidate('project')}>添加</button>
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="colhead"><h3>平台与迁移</h3></div>
        <div className="settings">
          <dt>启动目录</dt><dd className="mono"><Copyable text={boot?.projectRoot}>{boot?.projectRoot}</Copyable></dd>
          <dt>默认平台</dt>
          <dd>
            <select aria-label="默认平台" value={settings.defaultPlatform || 'claude-code'} onChange={(e) => setDefaultPlatform(e.target.value)}>
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
          <dt>迁移形态</dt>
          <dd>
            <select aria-label="迁移形态" value={settings.skillSyncMode === 'copy' ? 'copy' : 'symlink'} onChange={(e) => setSyncMode(e.target.value)}>
              <option value="symlink">软链接</option>
              <option value="copy">复制</option>
            </select>
          </dd>
          <dt>适配器总表</dt>
          <dd>{adapters.map((a) => (
            <Copyable key={a.id} className="adapter-dir mono" text={a.dir} title={`点击复制 ${a.id} 目录`}>
              {a.id} = {a.dir}
            </Copyable>
          ))}</dd>
          <dt>存储文件</dt><dd className="mono"><Copyable text={boot?.appStorePath}>{boot?.appStorePath}</Copyable></dd>
          <dt>面板端口</dt><dd>默认 7800（<code>nx-rh serve --port</code> 可改，仅绑定 127.0.0.1）</dd>
        </div>
      </div>

      <CliHints module="settings" />

      {dialogNode}
    </>
  );
}
