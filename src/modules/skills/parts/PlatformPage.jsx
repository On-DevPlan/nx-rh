// ② 平台子页：某个平台目录下的 skill（不在订阅源 / 已在订阅源两组）。
import { useState } from 'react';
import { api } from '../../../web/frontend/api/client.js';
import { useStore } from '../../../web/frontend/store.jsx';
import { useToast, useGuard, useDialog } from '../../../web/frontend/components/ui.jsx';
import { Crumbs, SkillCard, useSkillsData, useSel, makeHit, SCOPE_SHORT } from './shared.jsx';
import { SubmitIntoDialog } from './dialogs.jsx';
import { goSkill } from './routes.js';

export function PlatformPage({ platformId, tick }) {
  const { data, reload } = useSkillsData({ platform: platformId }, tick);
  const { boot, patchUi, toggleSel, refreshBoot } = useStore();
  const toast = useToast();
  const guard = useGuard();
  const { node: dialogNode } = useDialog();
  const [q, setQ] = useState('');
  const [submitNames, setSubmitNames] = useState(null);

  const settings = boot?.settings || {};
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
    await refreshBoot();
  });

  const platName = ((boot?.adapters || []).find((a) => a.id === platformId) || {}).name || platformId;

  return (
    <>
      <Crumbs trail={[{ label: platName }]} />
      <div className="sub-head">
        <div>
          <div style={{ fontSize: 15, fontWeight: 700 }}>{platName}</div>
          <div className="sub-meta">{managed.length} 个已在订阅源 · {orphans.length} 个不在订阅源</div>
        </div>
        <div className="acts">
          {orphans.some((o) => sel.has(o.name)) ? <button className="btn" onClick={() => setSubmitNames(orphans.map((o) => o.name).filter((n) => sel.has(n)))}>收进订阅源…</button> : null}
          <button className="btn ghost" onClick={toggleEnabled}>{enabled ? '移出启用范围' : '加入启用范围'}</button>
        </div>
      </div>

      <div className="toolbar">
        <input className="search grow" placeholder="过滤名称 / 描述…" value={q} spellCheck="false" onChange={(e) => setQ(e.target.value)} />
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
          onDone={async () => { setSubmitNames(null); patchUi({ selSkills: [] }); await reload(); }}
        />
      ) : null}
      {dialogNode}
    </>
  );
}
