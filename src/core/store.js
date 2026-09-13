// JSON 存储：用户目录下的单一数据文件，Web 表单与 agent CLI 共同读写。
// 设计要点（参考 json-server 的 lowdb 观察者思路，但零依赖实现）：
// - 原子写（临时文件 + rename），进程中断不会损坏数据
// - 进程内缓存 + mtime 失效检测：外部进程（如 CLI）改写后，Web 服务侧能立刻看到
// - 自己写入后主动刷新缓存 mtime，避免"自己触发自己重读"
import fsp from 'node:fs/promises';
import { dirname } from 'node:path';
import { storePathFromEnv } from './paths.js';

// settings 里按数组维护的键（写入时统一归一化）
const ARRAY_SETTINGS = ['platforms', 'skillCentralCandidates', 'skillProjectCandidates'];

const EMPTY = () => ({
  version: 1,
  settings: {
    skillCentralPath: '',
    skillSyncMode: 'symlink', // 'symlink' | 'copy'
    platforms: ['claude-code'], // 项目侧默认要支持哪些平台（适配器）
    defaultPlatform: 'claude-code', // 同步/推送时未指定平台则用它
    skillCentralCandidates: [], // 中心仓库候选目录（下拉多选项）
    skillProjectCandidates: [], // 项目目录候选（下拉多选项）
  },
  repos: [],
  skillGroups: [{ id: 'ungrouped', name: '未分组', skills: [] }],
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
  base.version = data.version ?? 1;
  base.settings = { ...base.settings, ...(data.settings || {}) };
  for (const key of ARRAY_SETTINGS) {
    base.settings[key] = toArray(base.settings[key]);
  }
  base.repos = Array.isArray(data.repos) ? data.repos : [];
  base.skillGroups =
    Array.isArray(data.skillGroups) && data.skillGroups.length ? data.skillGroups : base.skillGroups;
  return base;
}

export { ARRAY_SETTINGS };
