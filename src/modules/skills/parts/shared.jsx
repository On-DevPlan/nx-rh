// Skill 页各子页共用的轻量件：平台短名、数据 hook、面包屑、卡片、过滤谓词。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../../web/frontend/api/client.js';
import { useStore } from '../../../web/frontend/store.jsx';
import { SCOPE_MARK as SCOPE_SHORT, sourceLabel, lastSeg } from '../shared.js';

export { SCOPE_SHORT, sourceLabel, lastSeg };

export function shortLabel(adapterId, adapters) {
  const a = adapters.find((x) => x.id === adapterId);
  return (a ? a.name : adapterId).replace(/\s*\(.*\)$/, '').split(/[\s-]/)[0].toLowerCase();
}

// 名称/描述的即时过滤谓词：三个子页共用同一形态
export const makeHit = (q) => (n, d) => !q || `${n} ${d || ''}`.toLowerCase().includes(q.toLowerCase());

// 订阅源 + 平台维度的一份默认数据（总览、平台子页、订阅源子页共用）
//
// 刷新由两处驱动：局部 tick（本页需要强制重拉时用）与 store 的 dataEpoch
// （任何写操作成功后的全局广播）。旧的写法只认 tick，于是「在 A 页写、
// B 页的数据要跟着变」必须靠每一处调用方自觉——漏一处就是必须按 F5 的老毛病。
export function useSkillsData({ platform, source }, tick) {
  const { ui, dataEpoch } = useStore();
  const project = ui.activeScope?.path || '';
  const load = useCallback(async () => {
    const qs = new URLSearchParams();
    if (project) qs.set('project', project);
    if (platform) qs.set('platform', platform);
    if (source) qs.set('source', source);
    return await api('/api/skills?' + qs.toString()).catch(() => null);
  }, [project, platform, source]);

  const [data, setData] = useState(null);
  useEffect(() => { let alive = true; load().then((d) => { if (alive) setData(d); }); return () => { alive = false; }; }, [load, tick, dataEpoch]);
  return { data, reload: load, setData };
}

export function useSel() {
  const { ui } = useStore();
  return useMemo(() => new Set(ui.selSkills), [ui.selSkills]);
}

export function Crumbs({ trail }) {
  const goOverview = () => { location.hash = '#/skills'; };
  return (
    <div className="crumbs">
      <a onClick={goOverview}>Skill</a>
      {trail.map((t, i) => (
        <span key={i} style={{ display: 'contents' }}>
          <span className="sep">/</span>
          {i === trail.length - 1 || !t.on
            ? <span className="cur">{t.label}</span>
            : <a onClick={t.on}>{t.label}</a>}
        </span>
      ))}
    </div>
  );
}

export function SkillCard({ name, description, checked, onToggle, children, onClick }) {
  return (
    <div className="skl-card" onClick={onClick}>
      <div className="sc-top">
        <input
          type="checkbox" checked={checked}
          title="勾选用于批量操作"
          onClick={(e) => e.stopPropagation()}
          onChange={onToggle}
        />
        <span className="sc-name" title={name}>{name}</span>
      </div>
      <div className="sc-desc" title={description || ''}>{description}</div>
      <div className="sc-foot" onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>
  );
}
