// 全局面板状态：bootstrap 数据 + 会话级选择。
// 关键约定：凡是「刷新后不该丢」的用户选择（当前视图、中心/项目路径、多选勾选）
// 一律走 persist 读写 localStorage——UI 状态持久化是模板的硬标准，不是可选项。
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, setActiveScope } from './api/client.js';

const LS_KEY = 'nx-rh-ui';

// 只持久化「选择」，不持久化「数据」——数据永远从 /api 拉，避免陈旧缓存。
//
// activeScope：null = 跟随服务进程目录（serve <dir> / cwd）；否则为 recents 条目
// { scope, path, lastUsedAt }。项目级信息只针对激活的那个项目——右上角「最近目录」切换。
const DEFAULT_UI = {
  view: 'skills',     // 当前 tab（「仓库」页已于 2026-10-23 迁到 nx-kv）
  source: '',         // Skill 页选中的订阅源（留空 = 当前主源）
  activeScope: null,  // 激活的项目目录（右上角切换）
  selSkills: [],      // Skill 页多选勾选（skill 名）
  orphansOpen: false, // 「未入 Hub」区块展开与否（次要信息，默认收起）
  q: '',              // Skill 页搜索词（名称 / 描述，即时过滤）
  listFilter: 'all',  // Skill 页筛选：all | todo（未迁移）| conflict（跨源冲突）
};

function loadUi() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULT_UI };
    return { ...DEFAULT_UI, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_UI };
  }
}

const StoreCtx = createContext(null);

export function StoreProvider({ children }) {
  const [boot, setBoot] = useState(null);      // /api/bootstrap 结果
  const [bundled, setBundled] = useState(null);
  const [ui, setUi] = useState(loadUi);

  // UI 选择变化即落盘（同步、廉价、无版本迁移问题——字段级合并已兜底）
  useEffect(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(ui)); } catch { /* 隐私模式等场景静默降级 */ }
  }, [ui]);

  const refreshBoot = useCallback(async () => {
    const b = await api('/api/bootstrap');
    setBoot(b);
    return b;
  }, []);

  // ─── 写后失效：一处广播，全画面重拉 ────────────────────────────────
  // 改造前的缺口：每个写操作各自决定刷新范围（多数只 refreshBoot 或只 reload 当前页），
  // 于是「在平台范围里停用一个平台」之后，总览页的平台卡片仍是「已启用」；
  // 「从订阅源迁移若干 skill」回总览，平台统计数还是旧的——非 F5 不可见。
  //
  // 数据纪元（dataEpoch）：任何写操作成功后自增。所有「按需拉 /api 数据」的钩子把它
  // 放进 effect 依赖，纪元一变就重拉——谁需要刷新不再靠调用方逐个记得，而是统一广播。
  // 只放在内存里（不落 localStorage）：它是「数据版本」，不是用户选择。
  const [dataEpoch, setDataEpoch] = useState(0);

  const invalidate = useCallback(() => setDataEpoch((n) => n + 1), []);

  // 写操作成功后的唯一收尾：先广播失效，再把 bootstrap 放到后台（延迟一点）重拉。
  //
  // 两个约束叠在一起，决定了这里的顺序与延迟：
  //  1. bootstrap 带着 worktrees 聚合，本机实测 11.3s（其中 /api/wt/context 9.8s），
  //     而且它是**事件循环阻塞**式的——它跑的时候连 /api/health 都要等 11s。
  //     各视图真正需要的数据（/api/skills、/api/skills/detail…）只有几十毫秒。
  //  2. 所以先让写操作自己的提示和视图重拉走完（纪元同步 +1、数据请求先发出去），
  //     再延迟 300ms 放 bootstrap 出去；否则它会把后面所有请求堵在服务端。
  // 300ms 是「数据请求已发出且本机都答完了」的经验值，不为省流量，只为不被堵。
  const afterWrite = useCallback(() => {
    setDataEpoch((n) => n + 1);
    setTimeout(() => {
      refreshBoot().catch(() => { /* 后台补数据失败不该影响本次写操作的结果提示 */ });
    }, 300);
  }, [refreshBoot]);

  // 数据里已经不存在的名字要从「持久化勾选」里摘掉，否则批量按钮会凭空亮着
  // （「已选 3」但三项都删了，点下去什么都不剩）。只在删除类操作里按名字精确摘，
  // 不做「全量重投影」——勾选可以跨页携带，用某一页的数据全集去修剪会误删。
  const dropSel = useCallback((names) => {
    const gone = new Set(names || []);
    if (!gone.size) return;
    setUi((u) => {
      const next = u.selSkills.filter((n) => !gone.has(n));
      return next.length === u.selSkills.length ? u : { ...u, selSkills: next };
    });
  }, []);

  const refreshBundled = useCallback(async () => {
    setBundled(await api('/api/bundled').catch(() => null));
  }, []);

  useEffect(() => { refreshBoot(); refreshBundled(); }, [refreshBoot, refreshBundled]);

  // 支持对象 patch 与函数式 patch（函数式用于「基于最新 state 修剪」场景，避免闭包旧值覆盖）。
  // 必须在 switchScope 之前声明——它的依赖数组引用 patchUi，声明在后就是 TDZ 整页白屏。
  const patchUi = useCallback((patch) => {
    setUi((u) => (typeof patch === 'function' ? { ...u, ...patch(u) } : { ...u, ...patch }));
  }, []);

  // 作用域跟随「激活的项目」= 右上角选中的最近目录，否则服务进程目录。
  // 写进 api client 后，后续所有请求都带 x-nx-rh-scope，服务端据此切作用域。
  useEffect(() => { setActiveScope(ui.activeScope?.path || null); }, [ui.activeScope]);

  // 切换激活 scope：写 fetch 层 → touch recents（服务端置顶 + 登记）→ 重拉 bootstrap。
  // scopeTick 自增让视图重挂载重新拉数据（视图的 useEffect 只在挂载时请求）。
  const [scopeTick, setScopeTick] = useState(0);
  const switchScope = useCallback(async (entry) => {
    const next = entry || null;
    setActiveScope(next ? next.path : null);
    patchUi({ activeScope: next });
    if (next) await api('/api/recents', { method: 'POST', body: { path: next.path } }).catch(() => {});
    await refreshBoot().catch(() => {});
    setScopeTick((t) => t + 1);
  }, [patchUi, refreshBoot]);

  // 主动登记一个目录（右上角「＋ 注册其他目录」）：登记后立即切过去
  const registerDir = useCallback(async (path) => {
    if (!path) return null;
    // recents action 的参数名是 path（与 CLI `recents add <dir>` 一致），发 dir 会被静默忽略
    const recents = await api('/api/recents', { method: 'POST', body: { path } }).catch(() => null);
    await refreshBoot().catch(() => {});
    const entry = (recents || []).find((r) => r.path === path) || { scope: path, path };
    return entry;
  }, [refreshBoot]);

  const toggleSel = useCallback((key, name) => {
    setUi((u) => {
      const set = new Set(u[key]);
      if (set.has(name)) set.delete(name); else set.add(name);
      return { ...u, [key]: [...set] };
    });
  }, []);

  const value = useMemo(
    () => ({
      boot, bundled, ui, patchUi, toggleSel, refreshBoot, refreshBundled, switchScope, registerDir, scopeTick,
      // 写后失效三件套（见上方注释）：dataEpoch 当 effect 依赖，afterWrite 写后收尾，dropSel 修剪勾选
      dataEpoch, invalidate, afterWrite, dropSel,
    }),
    [boot, bundled, ui, patchUi, toggleSel, refreshBoot, refreshBundled, switchScope, registerDir, scopeTick,
      dataEpoch, invalidate, afterWrite, dropSel]
  );
  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreCtx);
  if (!ctx) throw new Error('useStore 必须在 StoreProvider 内使用');
  return ctx;
}
