// ② 平台子页：某个平台目录下的 skill（不在订阅源 / 已在订阅源两组）。
import { useState } from 'react';
import { api } from '../../../web/frontend/api/client.js';
import { useStore } from '../../../web/frontend/store.jsx';
import { useToast, useGuard, useDialog } from '../../../web/frontend/components/ui.jsx';
import { Crumbs, SkillCard, useSkillsData, useSel, makeHit, SCOPE_SHORT } from './shared.jsx';
import { SubmitIntoDialog } from './dialogs.jsx';
import { goOverview, goSkill } from './routes.js';

export function PlatformPage({ platformId, tick }) {
  // 数据刷新由 useSkillsData 内部订阅 store 的 dataEpoch 完成，本页不再持 reload
  const { data } = useSkillsData({ platform: platformId }, tick);
  const { boot, patchUi, toggleSel, afterWrite } = useStore();
  const toast = useToast();
  const guard = useGuard();
  const { node: dialogNode } = useDialog();
  const [q, setQ] = useState('');
  const [submitNames, setSubmitNames] = useState(null);

  // 平台范围优先读 /api/skills 载荷里的 settings（30ms 级），boot 兜底：
  // bootstrap 带了 worktrees 聚合，在有多工作树的大仓上要十秒级——开关平台时
  // 「按钮文案 / 启用标签」不该等它。data.settings 与 boot.settings 是同一份 store 的投影。
  const settings = { ...(boot?.settings || {}), ...(data?.settings || {}) };
  const enabled = (settings.platforms || []).includes(platformId);
  const sel = useSel();
  const hit = makeHit(q);

  // 该平台里「在订阅源」且实际存在的 skill
  const managed = (data?.skills || []).filter((s) => s.cells.some((c) => c.on));
  const orphans = data?.orphans || [];

  const toggleEnabled = () => guard(async () => {
    const scope = new Set(settings.platforms || []);
    let next;
    let def = settings.defaultPlatform;
    if (enabled) {
      next = [...scope].filter((x) => x !== platformId);
      if (!next.length) { toast('平台范围至少保留一个'); return; }
      if (def === platformId) def = next[0];
    } else {
      next = [...scope, platformId];
      if (!def) def = platformId;
    }
    await api('/api/settings', { method: 'POST', body: { platforms: next, defaultPlatform: def } });
    // 平台范围变了：本页的启用标签、总览页的平台卡片（enabled / isDefault）
    // 与各平台的 skill 统计都要跟着变——写后统一广播，别只刷 boot
    await afterWrite();
  });

  const platName = ((boot?.adapters || []).find((a) => a.id === platformId) || {}).name || platformId;

  return (
    <>
      <Crumbs trail={[{ label: platName }]} />
      <div className="page-head" style={{ marginBottom: 10 }}>
        <div className="title-block">
          <h2>{platName}</h2>
          <div className="sub-meta" style={{ marginTop: 2 }}>{managed.length} 个已在订阅源 · {orphans.length} 个不在订阅源</div>
        </div>
      </div>

      <div className="toolzone">
        <button className="btn small ghost" onClick={goOverview}>← 返回</button>
        <span className="sep"></span>
        <input className="search" placeholder="过滤名称 / 描述…" value={q} spellCheck="false" onChange={(e) => setQ(e.target.value)} />
        <div className="tz-acts">
          <button className="btn ghost" onClick={toggleEnabled}>{enabled ? '移出启用范围' : '加入启用范围'}</button>
          {orphans.some((o) => sel.has(o.name)) ? <button className="btn" onClick={() => setSubmitNames(orphans.map((o) => o.name).filter((n) => sel.has(n)))}>收进订阅源…</button> : null}
        </div>
      </div>

      {orphans.length ? (
        <>
          <div className="section-label">不在订阅源
            <span className="hint">这些只在平台目录里；勾选后可收进订阅源</span>
          </div>
          <div className="skl-grid">
            {orphans.filter((o) => hit(o.name, o.description)).map((o) => (
              <SkillCard
                key={o.name} name={o.name} description={o.description}
                checked={sel.has(o.name)} onToggle={() => toggleSel('selSkills', o.name)}
                onClick={() => goSkill(o.name)}
              >
                <span className="tag bad">不在订阅源</span>
                <span className="spacer"></span>
                <span className="sc-mini" onClick={() => goSkill(o.name)}>详情</span>
              </SkillCard>
            ))}
          </div>
        </>
      ) : null}

      <div className="section-label">已在订阅源
        <span className="hint">链接随订阅源实时变；实体副本是独立一份</span>
      </div>
      <div className="skl-grid">
        {managed.filter((s) => hit(s.name, s.description)).map((s) => (
          <SkillCard
            key={s.name} name={s.name} description={s.description}
            checked={sel.has(s.name)} onToggle={() => toggleSel('selSkills', s.name)}
            onClick={() => goSkill(s.name)}
          >
            {s.cells.filter((c) => c.on).map((c) => (
              <span key={c.scope} className={'sc-mini'} title={c.dir}>
                {SCOPE_SHORT[c.scope]}·{c.linkType ? '链接' : '副本'}
              </span>
            ))}
            <span className="spacer"></span>
            <span className="sc-mini" onClick={() => goSkill(s.name)}>详情</span>
          </SkillCard>
        ))}
        {!managed.length ? <div className="muted">（这个平台里还没有已收进订阅源的 skill）</div> : null}
      </div>

      {submitNames ? (
        <SubmitIntoDialog
          names={submitNames}
          onClose={() => setSubmitNames(null)}
          onDone={async () => { setSubmitNames(null); patchUi({ selSkills: [] }); }}
        />
      ) : null}
      {dialogNode}
    </>
  );
}
