// 全局面板状态：bootstrap 数据 + 会话级选择。
// 关键约定：凡是「刷新后不该丢」的用户选择（当前视图、中心/项目路径、多选勾选）
// 一律走 persist 读写 localStorage——UI 状态持久化是模板的硬标准，不是可选项。
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './api/client.js';

const LS_KEY = 'nx-rh-ui';

// 只持久化「选择」，不持久化「数据」——数据永远从 /api 拉，避免陈旧缓存。
const DEFAULT_UI = {
  view: 'repos',        // 当前 tab
  central: '',          // Skill 页选中的中心仓库路径
  project: '',          // Skill 页选中的项目目录路径
  selCentral: [],       // 中心侧多选勾选（skill 名）
  selProject: [],       // 项目侧多选勾选
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

  // 支持对象 patch 与函数式 patch（函数式用于「基于最新 state 修剪」场景，避免闭包旧值覆盖）
  const patchUi = useCallback((patch) => {
    setUi((u) => (typeof patch === 'function' ? { ...u, ...patch(u) } : { ...u, ...patch }));
  }, []);
  const toggleSel = useCallback((key, name) => {
    setUi((u) => {
      const set = new Set(u[key]);
      if (set.has(name)) set.delete(name); else set.add(name);
      return { ...u, [key]: [...set] };
    });
  }, []);

  const value = useMemo(
    () => ({ boot, bundled, ui, patchUi, toggleSel, refreshBoot, refreshBundled }),
    [boot, bundled, ui, patchUi, toggleSel, refreshBoot, refreshBundled]
  );
  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreCtx);
  if (!ctx) throw new Error('useStore 必须在 StoreProvider 内使用');
  return ctx;
}
