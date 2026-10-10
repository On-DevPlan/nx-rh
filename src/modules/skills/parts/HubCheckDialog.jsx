// 检查订阅源：跨源实文件重复与冲突（GET /api/skills/hub-check 的弹窗形态）。
// 报告 + 就地收敛：
//   · 来源配置问题（缺目录/空源/嵌套/重复根）→ 取消订阅（配置层动作）
//   · 跨源冲突 / 重复订阅 → 逐条「以此为准…」唯一化（POST /api/skills/dedupe）：
//     以选中那份实文件为准（勋章），其余 delete（彻底唯一）或 link（其余来源转
//     指向准份的链接——来源里仍可见，但链接不算来源，冲突随之消失）
//   · 「全部以主源为准」：所有组一键批量唯一化（POST /api/skills/dedupe-all），
//     每组以主源实文件为准、其余转软链接——一次性处理全部冲突，访问性不受影响
import { useEffect, useState } from 'react';
import { api } from '../../../web/frontend/api/client.js';
import { useStore } from '../../../web/frontend/store.jsx';
import { useToast, useGuard, useDialog, Modal, Copyable } from '../../../web/frontend/components/ui.jsx';

const HUB_PROBLEM_LABEL = { missing: '不存在', empty: '空源', 'same-root': '重复根', nested: '嵌套订阅' };
const HUB_PROBLEM_TONE  = { missing: 'bad',    empty: 'bad',  'same-root': 'bad',    nested: 'bad' };

export function HubCheckDialog({ onClose }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  // tick 触发重查：避免 useCallback 闭包坑，effect 依赖 tick 即可
  const [tick, setTick] = useState(0);
  // 唯一化确认视图（Modal 内容切换，不叠第二个弹窗）：{ name, winner, others }
  const [resolve, setResolve] = useState(null);

  useEffect(() => {
    let alive = true;
    setBusy(true); setErr('');
    api('/api/skills/hub-check')
      .then((r) => { if (alive) setD(r); })
      .catch((e) => { if (alive) setErr(String((e && e.message) || e)); })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [tick]);

  const { refreshBoot } = useStore();
  const toast = useToast();
  const guard = useGuard();
  const { dialog, node: dlgNode } = useDialog();

  // 配置层的修法：取消订阅该来源（不动磁盘上的 skill 文件）
  const removeSource = (path) => guard(async () => {
    const ok = await dialog({
      title: '取消订阅该来源',
      message: `确认取消订阅？\n${path}\n（订阅配置改动，不动磁盘上的 skill 文件）`,
      danger: true,
      okText: '取消订阅',
    });
    if (!ok) return;
    await api('/api/skills/sources', { method: 'DELETE', body: { path } });
    toast('已取消订阅');
    await refreshBoot();
    setTick((t) => t + 1); // 重查本弹窗
  });

  // skill 层的修法：唯一化。as=delete 删其余实文件；as=link 其余转为指向准份的链接。
  // 两种都会丢弃非准份的内容——面板确认视图本身就是闸门，force 随之带上。
  const runDedupe = (as) => guard(async () => {
    if (!resolve) return;
    setBusy(true);
    try {
      const r = await api('/api/skills/dedupe', {
        method: 'POST',
        body: { name: resolve.name, source: resolve.winner.source, as, force: true },
      });
      if (r.status === 'blocked') { toast(r.reason); return; }
      const n = r.linked.length + r.removed.length;
      toast(`已唯一化 ${resolve.name}：其余 ${n} 份${as === 'link' ? '已转链接' : '已删除'}${r.removed.some((x) => x.degraded) ? '（其中 1 处建链失败，已回填副本）' : ''}`);
      setResolve(null);
      await refreshBoot();
      setTick((t) => t + 1); // 重查，该组应从冲突/重复里消失
    } finally {
      setBusy(false);
    }
  });

  const conflicts = (d?.conflicts || []).filter((c) => !c.same);
  const duplicates = (d?.conflicts || []).filter((c) => c.same);
  const hubProblems = d?.hubProblems || [];
  const allGroups = conflicts.length + duplicates.length;

  // 批量快捷唯一化：全部重复/冲突组都以主源那份实文件为准，其余转软链接——
  // 一次性处理所有冲突，来源目录里仍可见（链接），访问性不受影响。
  const runDedupeAll = () => guard(async () => {
    const ok = await dialog({
      title: '全部以主源为准',
      message: `全部 ${allGroups} 组重复/冲突都以主源那份实文件为准，其余实文件转为指向准份的软链接。\n`
        + '各来源目录里这些 skill 仍可见（链接），但链接不算来源——冲突与重复随之消失。\n'
        + '非准份可能含本地改动，丢弃不可逆。',
      danger: true,
      okText: `全部以主源为准（${allGroups} 组）`,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await api('/api/skills/dedupe-all', { method: 'POST', body: { as: 'link', force: true } });
      if (r.status === 'blocked') { toast(r.reason); return; }
      toast(`已唯一化 ${r.totals.groups} 组：其余 ${r.totals.linked + r.totals.removed} 处已转软链接`
        + (r.totals.skipped ? `，跳过 ${r.totals.skipped} 处（与准份同一实体）` : '')
        + (r.totals.degraded ? `，${r.totals.degraded} 处建链失败已回填副本` : ''));
      await refreshBoot();
      setTick((t) => t + 1); // 重查，这些组应从冲突/重复里消失
    } finally {
      setBusy(false);
    }
  });

  // 唯一化确认视图：准份（勋章）+ 其余两选一处理
  if (resolve) {
    return (
      <Modal title={`唯一化 · ${resolve.name}`} onClose={() => setResolve(null)}>
        <div className="vlegend">
          以「以此为准」那份为唯一实文件（勋章）。其余 {resolve.others.length} 份二选一——两种处理都会丢弃非准份的内容。
        </div>
        <div className="list" style={{ border: '1px solid var(--soft-2)', borderRadius: 6 }}>
          <div className="row">
            <span className="tag strong" style={{ flex: '0 0 72px', textAlign: 'center' }}>以此为准</span>
            <Copyable className="desc mono" text={resolve.winner.source} title="点击复制来源路径">{resolve.winner.source}</Copyable>
            <span className="tag" style={{ fontFamily: 'ui-monospace, Consolas, monospace' }}>{resolve.winner.md5.slice(0, 8)}</span>
          </div>
          {resolve.others.map((e) => (
            <div key={e.source} className="row">
              <span className="tag bad" style={{ flex: '0 0 72px', textAlign: 'center' }}>待处理</span>
              <Copyable className="desc mono" text={e.source} title="点击复制来源路径">{e.source}</Copyable>
              <span className="tag" style={{ fontFamily: 'ui-monospace, Consolas, monospace' }}>{e.md5.slice(0, 8)}</span>
            </div>
          ))}
        </div>
        <div className="dlg-acts" style={{ marginTop: 12 }}>
          <button className="btn ghost" onClick={() => setResolve(null)}>返回</button>
          <span style={{ flex: 1 }} />
          <button
            className="btn danger" disabled={busy}
            title="删除其余来源的实文件——彻底的唯一实文件，其余来源里这个 skill 不复存在"
            onClick={() => runDedupe('delete')}
          >
            删除其余 {resolve.others.length} 份实文件
          </button>
          <button
            className="btn" disabled={busy}
            title="其余来源的实文件转为指向准份的链接——来源里仍可见，但链接不算来源、不再制造冲突"
            onClick={() => runDedupe('link')}
          >
            其余转软链接
          </button>
        </div>
        {dlgNode}
      </Modal>
    );
  }

  // 冲突/重复里每个来源一行：md5 前缀 + 来源路径 + 主源标记 + 「以此为准…」
  const renderEntry = (name, entries) => (e) => (
    <div key={e.source} className="row" style={{ paddingLeft: 12 }}>
      <span className="tag" style={{ flex: '0 0 72px', fontFamily: 'ui-monospace, Consolas, monospace' }}>{e.md5.slice(0, 8)}</span>
      <Copyable className="desc mono" text={e.source} title="点击复制来源路径">{e.source}</Copyable>
      {e.current ? <span className="tag strong">主源</span> : null}
      <span className="acts">
        <button
          className="btn small" title="以这份为唯一实文件（勋章）：其余删除或转为指向这份的软链接"
          onClick={() => setResolve({ name, winner: e, others: entries.filter((x) => x !== e) })}
        >
          以此为准…
        </button>
      </span>
    </div>
  );

  return (
    <Modal title="检查订阅源" onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        {d ? (
          <span className={'tag' + (d.ok ? ' strong' : ' bad')}>
            {d.ok
              ? '全部健康'
              : `有 ${hubProblems.length + conflicts.length} 处需处理${duplicates.length ? `（另有 ${duplicates.length} 个内容一致的重复订阅）` : ''}`}
          </span>
        ) : <span className="muted">{busy ? '检查中…' : '等待…'}</span>}
        <span style={{ flex: 1 }} />
        {allGroups ? (
          <button
            className="btn small" disabled={busy}
            title="全部重复/冲突组都以主源那份实文件为准，其余转软链接——一次性处理所有冲突，各来源目录里仍可见"
            onClick={runDedupeAll}
          >
            全部以主源为准（{allGroups} 组）
          </button>
        ) : null}
        <button className="btn small ghost" onClick={() => setTick((t) => t + 1)} disabled={busy}>
          {busy ? '检查中…' : '重新检查'}
        </button>
      </div>

      {err ? <div className="dlg-msg">检查失败：{err}</div> : null}

      {!d && !err ? <div className="muted">读取中…</div> : null}

      {d ? (
        <>
          <div className="vlegend">
            源 {d.summary.sources} 个 · 来源问题 {d.summary.hubProblems} · 跨源冲突 {d.summary.conflicts} · 内容一致的重复订阅 {d.summary.duplicates}
            {d.current ? <> · 主源 <code>{d.current}</code></> : null}
          </div>

          {hubProblems.length ? (
            <>
              <div className="section-label">来源配置问题<span className="hint">这些是「订阅配置」该修的，不是 skill 该修的</span></div>
              <div className="list" style={{ border: '1px solid var(--soft-2)', borderRadius: 6 }}>
                {hubProblems.map((p) => (
                  <div key={p.path + p.kind} className="row">
                    <span className={'tag ' + (HUB_PROBLEM_TONE[p.kind] || '')} style={{ flex: '0 0 72px', textAlign: 'center' }}>
                      {HUB_PROBLEM_LABEL[p.kind] || p.kind}
                    </span>
                    <Copyable className="desc mono" text={p.path} title="点击复制路径">{p.path}</Copyable>
                    <span className="muted" style={{ fontSize: 12, flex: '0 1 220px', textAlign: 'right' }}>{p.reason}</span>
                    <span className="acts">
                      <button className="btn small ghost" title="取消订阅该来源（订阅配置改动，不动磁盘）" onClick={() => removeSource(p.path)}>取消订阅</button>
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : null}

          {conflicts.length ? (
            <>
              <div className="section-label">跨源冲突（内容不同）<span className="hint">同名出现在多个源、md5 不同，迁移会 blocked。点一份「以此为准…」唯一化</span></div>
              <div className="list" style={{ border: '1px solid var(--soft-2)', borderRadius: 6 }}>
                {conflicts.map((c) => (
                  <div key={c.name} style={{ padding: '8px 10px', borderBottom: '1px solid var(--soft-2)' }}>
                    <div className="row" style={{ marginBottom: 2 }}>
                      <span className="name" style={{ fontWeight: 700 }}>{c.name}</span>
                      <span className="tag bad">{c.entries.length} 个来源</span>
                    </div>
                    {c.entries.map(renderEntry(c.name, c.entries))}
                  </div>
                ))}
              </div>
            </>
          ) : null}

          {duplicates.length ? (
            <>
              <div className="section-label">重复订阅（内容一致）<span className="hint">同名且 md5 相同。点一份「以此为准…」，其余删除或转链接</span></div>
              <div className="list" style={{ border: '1px solid var(--soft-2)', borderRadius: 6 }}>
                {duplicates.map((c) => (
                  <div key={c.name} style={{ padding: '8px 10px', borderBottom: '1px solid var(--soft-2)' }}>
                    <div className="row" style={{ marginBottom: 2 }}>
                      <span className="name" style={{ fontWeight: 700 }}>{c.name}</span>
                      <span className="tag">md5 {c.entries[0].md5.slice(0, 8)}</span>
                      <span className="tag">{c.entries.length} 个来源</span>
                    </div>
                    {c.entries.map(renderEntry(c.name, c.entries))}
                  </div>
                ))}
              </div>
            </>
          ) : null}

          {!hubProblems.length && !conflicts.length && !duplicates.length ? (
            <div className="muted" style={{ padding: 8 }}>所有订阅源都健康，没有跨源冲突或重复订阅。</div>
          ) : null}
        </>
      ) : null}

      {dlgNode}
      <div className="dlg-acts" style={{ marginTop: 12 }}>
        <button className="btn ghost" onClick={onClose}>关闭</button>
      </div>
    </Modal>
  );
}
