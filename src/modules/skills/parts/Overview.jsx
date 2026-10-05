// ① 总览页：订阅源入口 + 当前项目入口 + 全部平台入口 + 快捷设置。
import { api } from '../../../web/frontend/api/client.js';
import { useStore } from '../../../web/frontend/store.jsx';
import { useToast, useGuard, useDialog } from '../../../web/frontend/components/ui.jsx';
import { CliHints } from '../../../web/frontend/components/CliHints.jsx';
import { sourceLabel, lastSeg, shortLabel } from './shared.jsx';
import { goOverview, goPlatform, goHub, goProject } from './routes.js';

// 快捷设置浮层：迁移形态 / 默认平台 / 平台范围——Skill 域的高频设置就地可改，
// 不必跳去「设置」页（设置页保留完整形态，两边写同一个 POST /api/settings）。
function QuickSettings() {
  const { boot, refreshBoot } = useStore();
  const toast = useToast();
  const guard = useGuard();
  const s = boot?.settings || {};
  const adapters = boot?.adapters || [];
  const scope = new Set(s.platforms || []);

  const patch = (body) => guard(async () => {
    await api('/api/settings', { method: 'POST', body });
    await refreshBoot();
    toast('已保存');
  });

  const togglePlatform = (id) => {
    const next = scope.has(id) ? [...scope].filter((x) => x !== id) : [...scope, id];
    if (!next.length) { toast('平台范围至少保留一个'); return; }
    let def = s.defaultPlatform;
    if (!next.includes(def)) def = next[0];
    patch({ platforms: next, defaultPlatform: def });
  };

  return (
    <details className="tb-set">
      <summary>快捷设置</summary>
      <div className="tb-set-box">
        <div className="row-inline">
          <label>迁移形态</label>
          <select aria-label="迁移形态" value={s.skillSyncMode === 'copy' ? 'copy' : 'symlink'} onChange={(e) => patch({ skillSyncMode: e.target.value })}>
            <option value="symlink">软链接</option>
            <option value="copy">复制</option>
          </select>
        </div>
        <div className="row-inline">
          <label>默认平台</label>
          <select
            aria-label="默认平台"
            value={s.defaultPlatform || 'claude-code'}
            onChange={(e) => patch({ defaultPlatform: e.target.value, platforms: [e.target.value, ...[...scope].filter((x) => x !== e.target.value)] })}
          >
            {[...(scope.size ? scope : ['claude-code'])].map((id) => (
              <option key={id} value={id}>{(adapters.find((a) => a.id === id) || {}).name || id}</option>
            ))}
          </select>
        </div>
        <div className="row-inline">
          <label>平台范围</label>
          <span className="plats">
            {adapters.map((a) => (
              <button key={a.id} type="button" className={'pill' + (scope.has(a.id) ? ' on' : '')} onClick={() => togglePlatform(a.id)}>
                {shortLabel(a.id, adapters)}
              </button>
            ))}
          </span>
        </div>
      </div>
    </details>
  );
}

export function Overview({ data, openCreate }) {
  const guard = useGuard();
  const { dialog, node: dialogNode } = useDialog();
  const sources = data?.sources || [];
  const srcPaths = sources.map((s) => s.path);
  const summary = data?.platformSummary || [];

  const subscribe = () => guard(async () => {
    const p = await dialog({ title: '订阅一个 skill 目录（目录下直接是各 skill）', input: true });
    if (!p) return;
    await api('/api/skills/sources', { method: 'POST', body: { path: p } });
    goOverview();
  });

  return (
    <>
      <div className="page-head">
        <div className="title-block">
          <h2>Skill</h2>
          <div className="page-desc">
            订阅源是唯一可信源。从平台入口查看散落在各 Agent 目录里的 skill，把不在订阅源的收敛回来；也可以从订阅源把 skill 迁移到各平台。
          </div>
        </div>
        <div className="acts">
          <QuickSettings />
          {data?.hub?.path ? <button className="btn" onClick={openCreate}>＋ 新建</button> : null}
        </div>
      </div>

      <div className="section-label">订阅源
        <span className="hint">{sources.length} 个 · 点进去看 / 迁移该源的 skill</span>
      </div>
      <div className="entry-grid">
        {sources.map((s) => (
          <div key={s.path} className="entry-card" onClick={() => goHub(s.path)}>
            <div className="ec-top">
              <span className="ec-name">{sourceLabel(s.path, srcPaths)}</span>
              {s.current ? <span className="tag strong">主源</span> : null}
              {!s.exists ? <span className="tag bad">不存在</span> : null}
            </div>
            <div className="ec-path" title={s.path}>{s.path}</div>
            <div className="ec-stats"><span><b>{s.count}</b> 个 skill</span></div>
          </div>
        ))}
        <div className="entry-card add-tile" onClick={subscribe}>＋ 订阅新目录</div>
      </div>

      <div className="section-label">当前项目
        <span className="hint">项目目录里实际存在的 skill（cwd 作用域）</span>
      </div>
      <div className="entry-grid">
        {(() => {
          const ps = data?.projectSummary;
          if (!ps?.count) {
            return (
              <div className="entry-card off" onClick={goProject}>
                <div className="ec-top"><span className="ec-name">{lastSeg(ps?.root || '') || '当前项目'}</span></div>
                <div className="ec-path" title={ps?.root || ''}>{ps?.root || '（读取中…）'}</div>
                <div className="ec-stats"><span>项目目录里还没有 skill</span></div>
              </div>
            );
          }
          return (
            <div className="entry-card" onClick={goProject}>
              <div className="ec-top"><span className="ec-name">{lastSeg(ps.root)}</span></div>
              <div className="ec-path mono" title={ps.root}>{ps.root}</div>
              <div className="ec-stats">
                <span>有 <b>{ps.count}</b> skill</span>
                {ps.orphan ? <span style={{ color: 'var(--ink)' }} title="只在项目目录里，订阅源里没有——点进去可收进 Hub">，其中 <b>{ps.orphan}</b> 独立未入 Hub</span> : null}
              </div>
            </div>
          );
        })()}
      </div>

      <div className="section-label">平台
        <span className="hint">{summary.length} 个 Agent 平台 · 统计该平台目录里的 skill（用户级 + 当前项目级，同名只计一次）</span>
      </div>
      <div className="entry-grid">
        {summary.map((p) => {
          return (
            <div key={p.id} className={'entry-card' + (p.enabled ? '' : ' off')} onClick={() => goPlatform(p.id)}>
              <div className="ec-top">
                <span className="ec-name">{p.name}</span>
                {p.isDefault ? <span className="tag strong">默认</span>
                  : p.enabled ? <span className="tag">已启用</span>
                    : <span className="tag">未启用</span>}
              </div>
              <div className="ec-path mono">{p.id}</div>
              <div className="ec-stats">
                <span>有 <b>{p.managed + p.orphan}</b> skill</span>
                {p.orphan ? <span style={{ color: 'var(--ink)' }} title="只在平台目录里，订阅源里没有——点进去可收进 Hub">，其中 <b>{p.orphan}</b> 独立未入 Hub</span> : null}
              </div>
            </div>
          );
        })}
      </div>

      <CliHints module="skills" />
      {dialogNode}
    </>
  );
}
