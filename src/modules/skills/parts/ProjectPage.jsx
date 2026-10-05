// ② 当前项目子页：cwd 作用域下各平台项目目录里实际存在的 skill。
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../web/frontend/api/client.js';
import { useStore } from '../../../web/frontend/store.jsx';
import { useToast } from '../../../web/frontend/components/ui.jsx';
import { Copyable } from '../../../web/frontend/components/ui.jsx';
import { Crumbs, SkillCard, useSel, makeHit, shortLabel } from './shared.jsx';
import { SubmitIntoDialog } from './dialogs.jsx';
import { goSkill } from './routes.js';

function useProjectSkills(tick) {
  const { ui } = useStore();
  const project = ui.activeScope?.path || '';
  const load = useCallback(async () => {
    const qs = new URLSearchParams();
    if (project) qs.set('project', project);
    return await api('/api/skills/project-skills?' + qs.toString()).catch(() => null);
  }, [project]);
  const [data, setData] = useState(null);
  useEffect(() => { let alive = true; load().then((d) => { if (alive) setData(d); }); return () => { alive = false; }; }, [load, tick]);
  return { data, reload: load };
}

export function ProjectPage({ tick }) {
  const { data, reload } = useProjectSkills(tick);
  const { boot, patchUi, toggleSel } = useStore();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [submitNames, setSubmitNames] = useState(null);

  const adapters = boot?.adapters || [];
  const sel = useSel();
  const skills = data?.skills || [];

  const hit = makeHit(q);
  // 勾选里「不在订阅源」的那批才是可收进的
  const checkedOrphans = skills.filter((s) => !s.inHub && sel.has(s.name)).map((s) => s.name);

  return (
    <>
      <Crumbs trail={[{ label: '当前项目' }]} />
      <div className="sub-head">
        <div>
          <div style={{ fontSize: 15, fontWeight: 700 }}>项目里的 skill</div>
          <div className="sub-meta mono" title={data?.projectRoot}>{data?.projectRoot || '读取中…'}</div>
        </div>
        <div className="acts">
          {checkedOrphans.length ? <button className="btn" onClick={() => setSubmitNames(checkedOrphans)}>收进订阅源…</button> : null}
        </div>
      </div>

      <div className="toolbar">
        <input className="search grow" placeholder="过滤名称 / 描述…" value={q} spellCheck="false" onChange={(e) => setQ(e.target.value)} />
      </div>

      {data?.dirs?.length ? (
        <div className="section-label">项目目录
          <span className="hint">{data.dirs.length} 个平台目录 · * 为启用平台</span>
        </div>
      ) : null}
      {data?.dirs?.length ? (
        <div className="card"><div className="list">
          {data.dirs.map((dir) => (
            <div key={dir.platform} className="row">
              <span className="name">{dir.enabled ? '* ' : ''}{shortLabel(dir.platform, adapters)}</span>
              <Copyable className="desc mono" text={dir.dir} title="点击复制目录路径">{dir.dir}</Copyable>
              <span className="tag">{dir.skills.length} 个</span>
              {!dir.enabled ? <span className="tag">未启用</span> : null}
            </div>
          ))}
        </div></div>
      ) : null}

      <div className="section-label">skill
        <span className="hint">勾选「不在订阅源」的项可批量收进</span>
      </div>
      <div className="skl-grid">
        {skills.filter((s) => hit(s.name, s.description)).map((s) => (
          <SkillCard
            key={s.name} name={s.name} description={s.description}
            checked={sel.has(s.name)} onToggle={() => toggleSel('selSkills', s.name)}
            onClick={() => goSkill(s.name)}
          >
            {!s.inHub ? <span className="tag bad">不在订阅源</span> : <span className="tag">已在订阅源</span>}
            {s.cells.map((c) => (
              <span key={c.platform} className="sc-mini" title={c.dir}>
                {shortLabel(c.platform, adapters)}·{c.linkType ? '链接' : '副本'}
              </span>
            ))}
            <span className="spacer"></span>
            <span className="sc-mini" onClick={() => goSkill(s.name)}>详情</span>
          </SkillCard>
        ))}
        {data && !skills.length ? <div className="muted">（项目目录里还没有 skill）</div> : null}
        {!data ? <div className="muted">读取中…</div> : null}
      </div>

      {submitNames ? (
        <SubmitIntoDialog
          names={submitNames}
          onClose={() => setSubmitNames(null)}
          onDone={async () => { setSubmitNames(null); patchUi({ selSkills: [] }); await reload(); toast('已收进'); }}
        />
      ) : null}
    </>
  );
}
