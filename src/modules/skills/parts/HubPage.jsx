// ② 订阅源子页：某个订阅源里的 skill 卡片网格 + 批量迁移。
import { useEffect, useRef, useState } from 'react';
import { api } from '../../../web/frontend/api/client.js';
import { useStore } from '../../../web/frontend/store.jsx';
import { useToast, useGuard } from '../../../web/frontend/components/ui.jsx';
import { Crumbs, SkillCard, useSkillsData, useSel, makeHit, sourceLabel } from './shared.jsx';
import { MigrateToDialog, BatchPurgeDialog } from './dialogs.jsx';
import { goOverview, goSkill } from './routes.js';

export function HubPage({ hubPath, tick }) {
  const { data, reload } = useSkillsData({ source: hubPath }, tick);
  const { boot, patchUi, toggleSel, refreshBoot } = useStore();
  const toast = useToast();
  const guard = useGuard();
  const [q, setQ] = useState('');
  // 批量迁移与详情页走同一款 MigrateToDialog（平台复选 + 形态），
  // 这里只记点到的是哪半边按钮；平台选择不塞在页头下拉里。
  const [migrateTo, setMigrateTo] = useState(null); // 'project' | 'user' | null
  const [purgeOpen, setPurgeOpen] = useState(false); // 批量彻底删除

  const sel = useSel();
  const skills = data?.skills || [];
  const srcPaths = (data?.sources || []).map((s) => s.path);
  const isCurrent = (data?.sources || []).find((s) => s.current)?.path === hubPath;

  const hit = makeHit(q);
  // 过滤结果就是「全选」的作用域：先过滤、再全选 = 只选想要的那批
  const visible = skills.filter((s) => hit(s.name, s.description));
  // selSkills 跨页共享，批量只认本订阅源里的名字
  const checked = skills.filter((s) => sel.has(s.name)).map((s) => s.name);

  const allOn = visible.length > 0 && visible.every((s) => sel.has(s.name));
  const someOn = !allOn && visible.some((s) => sel.has(s.name));
  const allRef = useRef(null);
  useEffect(() => { if (allRef.current) allRef.current.indeterminate = someOn; }, [someOn]);

  const selectAll = () => patchUi((u) => {
    const set = new Set(u.selSkills);
    for (const s of visible) {
      if (allOn) set.delete(s.name); else set.add(s.name);
    }
    return { selSkills: [...set] };
  });

  const makeMain = () => guard(async () => {
    await api('/api/skills/sources', { method: 'POST', body: { path: hubPath } });
    await refreshBoot();
    toast('已设为主源');
  });

  return (
    <>
      <Crumbs trail={[{ label: sourceLabel(hubPath, srcPaths) }]} />
      <div className="page-head" style={{ marginBottom: 10 }}>
        <div className="title-block">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h2>{sourceLabel(hubPath, srcPaths)}</h2>
            {isCurrent ? <span className="tag strong">主源</span> : null}
          </div>
          <div className="sub-meta mono" style={{ marginTop: 2 }} title={hubPath}>{hubPath}</div>
        </div>
      </div>

      <div className="toolzone">
        <button className="btn small ghost" onClick={goOverview}>← 返回</button>
        <span className="sep"></span>
        <label className="chk-all" title="勾选当前过滤结果里的全部 skill（多选用于批量迁移）">
          <input ref={allRef} type="checkbox" checked={allOn} disabled={!visible.length} onChange={selectAll} />
          全选{visible.length ? `（${visible.length}）` : ''}
        </label>
        <input className="search" placeholder="过滤名称 / 描述…" value={q} spellCheck="false" onChange={(e) => setQ(e.target.value)} />
        <div className="tz-acts">
          {!isCurrent ? <button className="btn ghost" onClick={makeMain}>设为主源</button> : null}
          {checked.length ? <>
            <span className="tag strong" title={checked.join('、')}>已选 {checked.length}</span>
            <button className="btn ghost" onClick={() => patchUi({ selSkills: [] })}>清空勾选</button>
            <button className="btn" onClick={() => setMigrateTo('project')}>迁移勾选 → 项目…</button>
            <button className="btn ghost" onClick={() => setMigrateTo('user')}>迁移勾选 → 用户…</button>
            <button className="btn danger-quiet" title="连各平台安装位置与订阅源实文件一起删，不可恢复（先预演再确认）"
              onClick={() => setPurgeOpen(true)}>彻底删除…</button>
          </> : null}
        </div>
      </div>

      <div className="skl-grid">
        {visible.map((s) => {
          const on = s.cells.filter((c) => c.on).length;
          return (
            <SkillCard
              key={s.name} name={s.name} description={s.description}
              checked={sel.has(s.name)} onToggle={() => toggleSel('selSkills', s.name)}
              onClick={() => goSkill(s.name)}
            >
              <span className={'tag' + (on === s.cells.length && s.cells.length ? ' strong' : '')}>
                {s.cells.length ? `已安装 ${on}/${s.cells.length}` : '未安装'}
              </span>
              <span className="spacer"></span>
              <span className="sc-mini" onClick={() => goSkill(s.name)}>详情</span>
            </SkillCard>
          );
        })}
        {!skills.length ? <div className="muted">（这个订阅源里暂无 skill）</div> : null}
      </div>

      {migrateTo ? (
        <MigrateToDialog
          names={checked}
          to={migrateTo}
          boot={boot}
          onClose={() => setMigrateTo(null)}
          onDone={async () => { setMigrateTo(null); patchUi({ selSkills: [] }); await reload(); }}
        />
      ) : null}

      {purgeOpen ? (
        <BatchPurgeDialog
          names={checked}
          onClose={() => setPurgeOpen(false)}
          onDone={async () => { setPurgeOpen(false); patchUi({ selSkills: [] }); await reload(); refreshBoot(); }}
        />
      ) : null}
    </>
  );
}
