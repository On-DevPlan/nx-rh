// JSON 存储：用户目录下的单一数据文件，Web 表单与 agent CLI 共同读写。
// 设计要点（参考 json-server 的 lowdb 观察者思路，但零依赖实现）：
// - 原子写（临时文件 + rename），进程中断不会损坏数据
// - 进程内缓存 + mtime 失效检测：外部进程（如 CLI）改写后，Web 服务侧能立刻看到
// - 自己写入后主动刷新缓存 mtime，避免"自己触发自己重读"
import fsp from 'node:fs/promises';
import { dirname } from 'node:path';
import { storePathFromEnv } from './paths.js';

// settings 里按数组维护的键（写入时统一归一化）
const ARRAY_SETTINGS = ['platforms', 'skillHubSources', 'skillProjectCandidates'];

const EMPTY = () => ({
  version: 2,
  settings: {
    skillHubPath: '', // 当前主订阅源（Skill Hub 仓库根）
    skillSyncMode: 'symlink', // 'symlink' | 'copy'（迁移默认形态）
    platforms: ['claude-code', 'workbuddy'], // 默认聚焦的平台（适配器）
    defaultPlatform: 'claude-code', // 迁移时未指定平台则用它
    skillHubSources: [], // 订阅源目录（可多个、可重叠）
    skillProjectCandidates: [], // 项目目录候选（下拉多选项）
  },
  repos: [], // 仓库登记（repos 模块的所有数据）
  // 「最近项目」：全局跨作用域的一份列表（最多 20 条，最近在前）。
  // 与按 cwd 隔离的桶并存——切项目的入口数据源就是它。
  recents: [],
});

let cache = null;
let cacheMtime = -1;

export function newId(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export async function loadStore(explicitPath) {
  const p = explicitPath || storePathFromEnv();
  try {
    const st = await fsp.stat(p);
    if (cache && cacheMtime === st.mtimeMs) return cache;
    const raw = await fsp.readFile(p, 'utf8');
    cache = normalize(JSON.parse(raw));
    cacheMtime = st.mtimeMs;
    return cache;
  } catch {
    // 文件不存在或损坏：返回空结构（首次运行 / 允许外部修复后恢复）
    cache = normalize(null);
    cacheMtime = -1;
    return cache;
  }
}

export async function saveStore(next, explicitPath) {
  const p = explicitPath || storePathFromEnv();
  const data = normalize(next);
  await fsp.mkdir(dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, p);
  cache = data;
  try {
    cacheMtime = (await fsp.stat(p)).mtimeMs;
  } catch {
    cacheMtime = -1;
  }
  return data;
}

// 读-改-写事务：fn 直接修改传入的深拷贝 store；fn 抛错则不落盘
export async function mutateStore(fn, explicitPath) {
  const cur = structuredClone(await loadStore(explicitPath));
  const result = fn(cur);
  await saveStore(cur, explicitPath);
  return result === undefined ? cur : result;
}

function toArray(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(',').map((x) => x.trim()).filter(Boolean);
  return [];
}

function normalize(data) {
  const base = EMPTY();
  if (!data || typeof data !== 'object') return base;
  base.version = data.version ?? 2;
  const s = { ...base.settings, ...(data.settings || {}) };

  // 旧键回填：0.9.x 及更早用 skillCentralPath / skillCentralCandidates 表达「唯一中心仓库」。
  // 新模型是「订阅源列表」，语义可直接平移，迁移后旧键不再保留，避免两套并存。
  if (!s.skillHubPath && data.settings?.skillCentralPath) s.skillHubPath = data.settings.skillCentralPath;
  if (!Array.isArray(s.skillHubSources) || !s.skillHubSources.length) {
    const legacy = data.settings?.skillCentralCandidates;
    if (Array.isArray(legacy) && legacy.length) s.skillHubSources = legacy;
  }
  delete s.skillCentralPath;
  delete s.skillCentralCandidates;

  base.settings = s;
  for (const key of ARRAY_SETTINGS) {
    base.settings[key] = toArray(base.settings[key]);
  }
  base.repos = Array.isArray(data.repos) ? data.repos : [];
  base.recents = Array.isArray(data.recents) ? data.recents : [];
  return base;
}

export { ARRAY_SETTINGS };
