// 设置 service：store.settings 的读写，以及订阅源 / 项目目录候选的维护。
//
// 定位：**基础模块**。它是唯一允许被其他模块只读依赖的模块（skills 需要知道订阅源在哪），
// 反向依赖禁止。把设置从 skills 里拆出来的动因很直接——改造前 updateSettings 定义在
// skills.js，于是「任何模块想加一个设置项」都得去改 skill 的代码。
//
// 术语：**订阅源（source / hub）**= 被订阅的 Skill Hub 仓库目录，是 skill 的唯一可信源；
// 可以订阅多个、允许重叠。**项目目录**= 迁移目标所在的仓库根（默认取启动目录）。
import { resolve } from 'node:path';
import { loadStore, mutateStore, ARRAY_SETTINGS } from '../../core/store.js';
import { badInput } from '../../core/errors.js';
import { samePath } from '../../core/link.js';

export async function getSettings() {
  return (await loadStore()).settings;
}

function toArray(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(',').map((x) => x.trim()).filter(Boolean);
  return [];
}

export async function updateSettings(patch) {
  return mutateStore((s) => {
    for (const [k, v] of Object.entries(patch || {})) {
      if (k === 'skillHubPath') {
        const p = resolve(String(v || ''));
        s.settings.skillHubPath = v ? p : '';
        // 设为主源时自动纳入订阅列表，避免「当前源不在候选里」的悬空状态
        if (v && !s.settings.skillHubSources.some((c) => c.toLowerCase() === p.toLowerCase())) {
          s.settings.skillHubSources.push(p);
        }
        continue;
      }
      if (ARRAY_SETTINGS.includes(k)) {
        s.settings[k] = toArray(v);
        continue;
      }
      if (v !== undefined) s.settings[k] = String(v);
    }
    if (s.settings.skillSyncMode !== 'copy') s.settings.skillSyncMode = 'symlink';
    if (!s.settings.platforms.length) s.settings.platforms = ['claude-code'];
    // 默认平台必须落在平台范围内，否则每次迁移都要回退，语义不明确
    if (!s.settings.platforms.includes(s.settings.defaultPlatform)) {
      s.settings.defaultPlatform = s.settings.platforms[0];
    }
    return { ...s.settings };
  });
}

// ─── 当前订阅源（主 Skill Hub） ─────────────────────────────────────
// 报错文案里的「未设置」是 agent 失败分类的锚点（见 assets/nx-rh/references/
// agent-workflow.md），改动前先确认不会破坏它。

export async function hubPath() {
  const s = await loadStore();
  return s.settings.skillHubPath ? resolve(s.settings.skillHubPath) : '';
}

export async function requireHubPath() {
  const p = await hubPath();
  if (!p) throw badInput('未设置 Skill Hub 订阅源（nx-rh skill hub add <path>）');
  return p;
}

export async function setHubPath(path) {
  if (!path) throw badInput('path 不能为空');
  await updateSettings({ skillHubPath: resolve(String(path)) });
  return { skillHubPath: resolve(String(path)) };
}

// ─── 订阅源 / 项目目录候选 ──────────────────────────────────────────

const CANDIDATE_KEY = {
  hub: 'skillHubSources',
  project: 'skillProjectCandidates',
};

function candidateKey(kind) {
  const k = CANDIDATE_KEY[kind];
  if (!k) throw badInput('kind 必须是 hub 或 project，收到: ' + kind);
  return k;
}

export async function listCandidates(kind) {
  return (await loadStore()).settings[candidateKey(kind)];
}

export async function addCandidate(kind, path) {
  const key = candidateKey(kind);
  if (!path) return (await loadStore()).settings[key];
  return mutateStore((s) => {
    const abs = resolve(String(path));
    if (!s.settings[key].some((p) => p.toLowerCase() === abs.toLowerCase())) {
      s.settings[key].push(abs);
    }
    // 订阅源新增即设为主源——用户加源的动作本身就表达了「用它」
    if (kind === 'hub') s.settings.skillHubPath = abs;
    return [...s.settings[key]];
  });
}

// 移除候选：仅从列表移除，不动磁盘、不动登记。
// 移出的若正是当前主源，一并清空该选中项（否则会留下悬空的当前值）。
//
// 移出一个本就不在列表里的路径**不算错误**——这保持了操作的幂等性
// （agent-workflow.md 把「重复执行安全」列为可依赖契约）。
export async function removeCandidate(kind, path) {
  const key = candidateKey(kind);
  return mutateStore((s) => {
    const abs = resolve(String(path));
    s.settings[key] = s.settings[key].filter((p) => p.toLowerCase() !== abs.toLowerCase());
    if (kind === 'hub' && samePath(s.settings.skillHubPath, abs)) {
      s.settings.skillHubPath = '';
    }
    return [...s.settings[key]];
  });
}
