// ② 订阅源子页：某个订阅源里的 skill 卡片网格 + 批量迁移。
import { useState } from 'react';
import { api } from '../../../web/frontend/api/client.js';
import { useStore } from '../../../web/frontend/store.jsx';
import { useToast, useGuard, useDialog } from '../../../web/frontend/components/ui.jsx';
import { Crumbs, SkillCard, useSkillsData, useSel, makeHit, SCOPE_SHORT, sourceLabel } from './shared.jsx';
import { goSkill } from './routes.js';

export function HubPage({ hubPath, tick }) {
  const { data, reload } = useSkillsData({ source: hubPath }, tick);
  const { boot, patchUi, toggleSel, refreshBoot } = useStore();
  const toast = useToast();
  const guard = useGuard();
  const { dialog, node: dialogNode } = useDialog();
  const [q, setQ] = useState('');
  // 批量迁移形态：auto = 跟随全局设置（快捷设置里的「迁移形态」）
  const [batchMode, setBatchMode] = useState('auto');

  const settings = boot?.settings || {};
  const sel = useSel();
  const skills = data?.skills || [];
  const srcPaths = (data?.sources || []).map((s) => s.path);
  const isCurrent = (data?.sources || []).find((s) => s.current)?.path === hubPath;

  const hit = makeHit(q);

  const makeMain = () => guard(async () => {
    await api('/api/skills/sources', { method: 'POST', body: { path: hubPath } });
    await refreshBoot();
    toast('已设为主源');
  });

  const bulkMigrate = (to) => guard(async () => {
    const names = skills.map((s) => s.name).filter((n) => sel.has(n));
    if (!names.length) { toast('勾选要迁移的 skill'); return; }
    // mode：跟随设置（缺省）/ 软链接 / 复制——按次覆盖，不改全局设置
    const mode = batchMode === 'auto' ? undefined : batchMode;
    const how = mode === 'copy' ? '复制' : mode === 'symlink' ? '软链接' : (settings.skillSyncMode === 'copy' ? '复制' : '软链接');
    const ok = await dialog({ message: `将勾选的 ${names.length} 个 skill 迁移到${SCOPE_SHORT[to]}？\n形态: ${how}` });
    if (!ok) return;
    const r = await api('/api/skills/migrate', {
      method: 'POST',
      body: { name: names, to, platform: 'all', ...(mode ? { mode } : {}) },
    });
    if (r.status === 'blocked') toast(`${r.blocked.length} 处被阻止（跨源冲突，先解决订阅）`);
    else toast(`已迁移 ${r.migrated} 处（跳过 ${r.skipped}）`);
    patchUi({ selSkills: [] });
    await reload();
  });

  return (
    <>
      <Crumbs trail={[{ label: sourceLabel(hubPath, srcPaths) }]} />
      <div className="sub-head">
        <div>
          <div style={{ fontSize: 15, fontWeight: 700 }}>{sourceLabel(hubPath, srcPaths)}</div>
          <div className="sub-meta mono" title={hubPath}>{hubPath}</div>
        </div>
        <div className="acts">
          {!isCurrent ? <button className="btn ghost" onClick={makeMain}>设为主源</button> : <span className="tag strong">主源</span>}
          {[...sel].length ? <>
            <select aria-label="迁移形态" title="本次批量迁移的形态" value={batchMode} onChange={(e) => setBatchMode(e.target.value)} style={{ maxWidth: 120 }}>
              <option value="auto">形态: 跟随设置</option>
              <option value="symlink">形态: 软链接</option>
              <option value="copy">形态: 实体复制</option>
            </select>
            <button className="btn" onClick={() => bulkMigrate('project')}>迁移勾选 → 项目</button>
            <button className="btn" onClick={() => bulkMigrate('user')}>迁移勾选 → 用户</button>
          </> : null}
        </div>
      </div>

      <div className="toolbar">
        <input className="search grow" placeholder="过滤名称 / 描述…" value={q} spellCheck="false" onChange={(e) => setQ(e.target.value)} />
      </div>

      <div className="skl-grid">
        {skills.filter((s) => hit(s.name, s.description)).map((s) => {
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

      {dialogNode}
    </>
  );
}
