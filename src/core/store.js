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
    platforms: ['claude-code'], // 默认只启用 claude-code；其余平台在「平台范围」里按需开（首个即默认平台）
    defaultPlatform: 'claude-code', // 迁移时未指定平台则用它
    skillHubSources: [], // 订阅源目录（可多个、可重叠）
    skillProjectCandidates: [], // 项目目录候选（下拉多选项）
  },
  // 仓库登记（repos）与仓库看板（boards）已于 2026-10-23 迁到 nx-kv
  // （远程清单 topic=goal 的 #72）：仓库登记是本机事实，它的价值是给
  // 「本地任务管理」当上下文，所以它跟着任务走。nx-kv 侧落在 ~/.nx-kv/repos.json，
  // 命令是 `nx-kv repo ...` / `nx-kv board ...`。
  // worktrees 模块的状态：按主仓库的 cwdScope 分桶，
  // 只存 git 不知道的东西（扩展文件登记 + 模块配置）；工作树清单本身以 git 为准。
  worktreeState: {},
  // 「最近项目」：全局跨作用域的一份列表（最多 20 条，最近在前）。
  // 与按 cwd 隔离的桶并存——切项目的入口数据源就是它。
  recents: [],
  // 远程订阅源元数据：sourceDir → { spec, type, url, ref?, subpath?, id, fetchedAt }。
  // 键是注册进 skillHubSources 的那个路径；值只记「这个源从哪来、何时拉的」，
  // 内容真相始终在磁盘（remote-skills/<id>/）。R2 的 sync 按它对比变更。
  remoteSources: {},
  // 远程 Hub：唯一一个装着外部 skill 的容器（落位 ~/.nx-rh/remote-hub/）。
  // skills: { [skill名]: { spec, url, ref, skillPath, hash, importedAt, updatedAt } }
  // —— hash 就是这个 skill 的「版本」，updatedAt 是「何时更新的」。
  remoteHub: { dir: '', skills: {} },
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
  // repos / boards 已迁到 nx-kv（2026-10-23），这里不再保留它们的字段。
  base.worktreeState =
    data.worktreeState && typeof data.worktreeState === 'object' ? data.worktreeState : {};
  base.recents = Array.isArray(data.recents) ? data.recents : [];
  base.remoteSources =
    data.remoteSources && typeof data.remoteSources === 'object' ? data.remoteSources : {};
  base.remoteHub =
    data.remoteHub && typeof data.remoteHub === 'object'
      ? { dir: String(data.remoteHub.dir || ''), skills: data.remoteHub.skills && typeof data.remoteHub.skills === 'object' ? data.remoteHub.skills : {} }
      : { dir: '', skills: {} };
  return base;
}

export { ARRAY_SETTINGS };
