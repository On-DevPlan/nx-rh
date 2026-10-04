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
  view: 'repos',      // 当前 tab
  source: '',         // Skill 页选中的订阅源（留空 = 当前主源）
  activeScope: null,  // 激活的项目目录（右上角切换）
  selSkills: [],      // Skill 页多选勾选（skill 名）
  orphansOpen: false, // 「未入 Hub」区块展开与否（次要信息，默认收起）
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
    () => ({ boot, bundled, ui, patchUi, toggleSel, refreshBoot, refreshBundled, switchScope, registerDir, scopeTick }),
    [boot, bundled, ui, patchUi, toggleSel, refreshBoot, refreshBundled, switchScope, registerDir, scopeTick]
  );
  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreCtx);
  if (!ctx) throw new Error('useStore 必须在 StoreProvider 内使用');
  return ctx;
}
