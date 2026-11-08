// ① 总览页：远程订阅管理 + 订阅源 + 当前项目 + 全部平台入口 + Skill 设置。
//
// 版面顺序即重要性：远程订阅是「外部 skill 的入口」，放在最前面。
// 平台区保持大卡片网格（沿用改造前的形态）——卡片带平台全名、目录与统计，
// 扫一眼就知道每个平台装了什么。
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../web/frontend/api/client.js';
import { useStore } from '../../../web/frontend/store.jsx';
import { useGuard, useDialog, useToast, Copyable } from '../../../web/frontend/components/ui.jsx';
import { CliHints } from '../../../web/frontend/components/CliHints.jsx';
import { sourceLabel, lastSeg } from './shared.jsx';
import { goOverview, goPlatform, goHub, goProject, goRemote, goRemoteSeg } from './routes.js';
import { SkillSettingsDialog } from './dialogs.jsx';
import { HubCheckDialog } from './HubCheckDialog.jsx';

// 相对时间（与 RemotePage 同款口径）
const ago = (iso) => {
  if (!iso) return '—';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
};

// 远程订阅管理区块：状态 + 待更新清单 + 动作入口。
//
// 版式约定（沿用本项目的卡片语汇）：
//   · 上面的 section-label 已经是「远程订阅」——卡片里不再重复标题，
//     否则同一句话在一屏里出现两次。
//   · 统计是**分开的短项**（数字加粗），不是「A · B · C」连写的一句话——
//     连写的话在按钮旁边会被挤成一条，读不出重点。
//   · 主体区只在**真有话要说**时出现（有 skill 待更新就列出来）；
//     没话说时不留占位句，空着比写废话干净。
//   · 「待更新」数读的是**上次检查的缓存**（store.remoteRepo.lastCheck），
//     不是每次都联网——总览要秒开，检查是用户主动点的动作。
//
// **按钮只留两个**：检查更新（总览自己就能做，且状态就在这儿）
// 与「管理…」（其余动作都在远程页里做）。
// 「按地址安装」「搜索导入」也是去远程页——只是落在不同区段，
// 总览摆四个按钮会让整页按钮密度失控（页头已有 3 个、订阅源区还有 1 个）。
function RemoteBlock({ remote, onCheck, checking, onManage, onFind }) {
  const skills = remote?.skills || [];
  const last = remote?.lastCheck || null;
  const outdated = (last?.outdated || []).filter((n) => skills.some((s) => s.name === n));
  const installed = skills.filter((s) => (s.cells || []).some((c) => c.on)).length;

  if (!remote) {
    return (
      <div className="card">
        <div className="colhead">
          <span className="muted">读取中…</span>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="colhead">
        {/* 状态：分开的短项，数字加粗（与订阅源卡片的 ec-stats 同款语汇） */}
        <span className="stat-group">
          <span><b>{skills.length}</b> 个已导入</span>
          <span><b>{installed}</b> 个已装到平台</span>
          <span>{last?.at ? `${ago(last.at)}检查过上游` : '尚未检查上游'}</span>
        </span>
        {outdated.length ? <span className="tag strong">{outdated.length} 个待更新</span> : null}
        <span style={{ flex: 1 }} />
        <button className="btn small ghost" onClick={onCheck} disabled={checking}
          title="比对上游有没有新版本（只读，不改磁盘）">
          {checking ? '检查中…' : '检查更新'}
        </button>
        <button className="btn small ghost" onClick={onManage}
          title="打开远程订阅管理页（查看全部、安装、更新、移除）">
          管理…
        </button>
      </div>

      {/* 主体只在有内容时出现 */}
      {outdated.length ? (
        <div className="list">
          {outdated.map((name) => {
            const s = skills.find((x) => x.name === name);
            return (
              <div key={name} className="row">
                <span className="name">{name}</span>
                <Copyable className="desc mono" text={s?.spec || ''} title="点击复制来源">{s?.spec}</Copyable>
                <span className="acts">
                  <button className="btn small ghost" onClick={onManage}>去更新</button>
                </span>
              </div>
            );
          })}
        </div>
      ) : !skills.length ? (
        <div className="row">
          <span className="desc">远程订阅是外部 skill 的唯一入口——搜到想要的，导入后装到各平台目录。</span>
          <span className="acts">
            <button className="btn small ghost" onClick={onFind}>去搜索</button>
          </span>
        </div>
      ) : null}
    </div>
  );
}

export function Overview({ data, openCreate }) {
  const guard = useGuard();
  const toast = useToast();
  const { afterWrite } = useStore();
  const { dialog, node: dialogNode } = useDialog();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [checkOpen, setCheckOpen] = useState(false);
  const [remote, setRemote] = useState(null);
  const [checking, setChecking] = useState(false);
  const sources = data?.sources || [];
  const srcPaths = sources.map((s) => s.path);
  const summary = data?.platformSummary || [];

  // 远程订阅的数据单独拉：/api/skills 要扫全平台（几十毫秒到秒级），
  // /api/skills/remote 只扫一个目录——分开拉，总览能更早出内容。
  const loadRemote = useCallback(async () => {
    setRemote(await api('/api/skills/remote').catch(() => null));
  }, []);

  useEffect(() => { loadRemote(); }, [loadRemote]);

  const subscribe = () => guard(async () => {
    const p = await dialog({
      title: '订阅 skill 目录',
      input: true,
      placeholder: '本地目录（目录下直接是各 skill）',
      message: '外部 skill 走「远程订阅」页（搜索导入 / 添加定义 / 版本更新）。',
    });
    if (!p) return;
    await api('/api/skills/sources', { method: 'POST', body: { path: p }, timeoutMs: 120000 });
    // 原来只 goOverview()——但当前已经在 #/skills，hash 不变就不触发路由事件，
    // 新订阅源不出现在网格里，看起来像「点了没反应」。写后广播才是正解。
    await afterWrite();
    goOverview();
  });

  // 检查上游版本：只读，不换盘。检查完刷新远程区块（徽标要立刻跟上）。
  const checkRemote = () => guard(async () => {
    if (checking) return;
    setChecking(true);
    try {
      const r = await api('/api/skills/remote/check', { timeoutMs: 300000 });
      await loadRemote();
      await afterWrite();
      const n = r.outdated || 0;
      if (n) toast(`检查完成：${n} 个待更新（上游提交未变的 ${r.upToDate || 0} 个）`, 'warn');
      else toast(`检查完成：${r.checked || 0} 个都是最新的`);
    } finally {
      setChecking(false);
    }
  });

  return (
    <>
      <div className="page-head">
        <div className="title-block">
          <h2>Skill</h2>
          <div className="page-desc">
            订阅源是唯一可信源；从远程订阅导入外部 skill，再铺到各平台目录。
          </div>
        </div>
      </div>

      <div className="toolzone">
        <div className="tz-filter">
          <span className="muted">外部 skill 从远程订阅进来，铺到各平台目录</span>
        </div>
        <div className="tz-acts">
          <button className="btn ghost" onClick={() => setCheckOpen(true)}>检查订阅源…</button>
          <button className="btn ghost" onClick={() => setSettingsOpen(true)}>Skill 设置</button>
          {data?.hub?.path ? <button className="btn" onClick={openCreate}>＋ 新建</button> : null}
        </div>
      </div>

      <div className="section-label">远程订阅
        <span className="hint">外部 skill 的唯一入口</span>
      </div>
      <RemoteBlock
        remote={remote}
        checking={checking}
        onCheck={checkRemote}
        onManage={goRemote}
        onFind={() => goRemoteSeg('find')}
      />

      <div className="section-label">订阅源
        <span className="hint">{sources.length} 个 · 点进去看 / 迁移该源的 skill</span>
      </div>
      <div className="entry-grid">
        {sources.map((s) => (
          <div key={s.path} className="entry-card" onClick={() => goHub(s.path)}>
            <div className="ec-top">
              <span className="ec-name">{s.remote ? '远程订阅' : sourceLabel(s.path, srcPaths)}</span>
              {s.current ? <span className="tag strong">主源</span> : null}
              {s.remote ? <span className="tag">外部 skill</span> : null}
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
      {settingsOpen ? <SkillSettingsDialog onClose={() => setSettingsOpen(false)} settings={data?.settings} /> : null}
      {checkOpen ? <HubCheckDialog onClose={() => setCheckOpen(false)} /> : null}
      {dialogNode}
    </>
  );
}
