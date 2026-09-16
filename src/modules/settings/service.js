// 设置 service：store.settings 的读写，以及中心/项目目录候选的维护。
//
// 定位：**基础模块**。它是唯一允许被其他模块只读依赖的模块（skills 需要知道中心仓库在哪），
// 反向依赖禁止。把设置从 skills 里拆出来的动因很直接——改造前 updateSettings 定义在
// skills.js，于是「任何模块想加一个设置项」都得去改 skill 的代码。
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
      if (k === 'skillCentralPath') {
        const p = resolve(String(v || ''));
        s.settings.skillCentralPath = v ? p : '';
        if (v && !s.settings.skillCentralCandidates.some((c) => c.toLowerCase() === p.toLowerCase())) {
          s.settings.skillCentralCandidates.push(p);
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
    return { ...s.settings };
  });
}

// ─── 中心仓库路径 ──────────────────────────────────────────────────
// 报错文案里的「未设置」是 agent 失败分类的锚点（见 assets/repo-hub/references/
// agent-workflow.md），改动前先确认不会破坏它。

export async function centralPath() {
  const s = await loadStore();
  if (!s.settings.skillCentralPath) {
    throw badInput('未设置 skill 中心仓库路径（nx-rh skill central <path>）');
  }
  return resolve(s.settings.skillCentralPath);
}

export async function setCentralPath(path) {
  if (!path) throw badInput('path 不能为空');
  await updateSettings({ skillCentralPath: resolve(String(path)) });
  return { skillCentralPath: resolve(String(path)) };
}

// ─── 目录候选（中心仓库 / 项目目录，供 UI 下拉与多选） ──────────────

const CANDIDATE_KEY = {
  central: 'skillCentralCandidates',
  project: 'skillProjectCandidates',
};

function candidateKey(kind) {
  const k = CANDIDATE_KEY[kind];
  if (!k) throw badInput('kind 必须是 central 或 project，收到: ' + kind);
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
    return [...s.settings[key]];
  });
}

// 移除候选：仅从列表移除，不动磁盘、不动登记。
// 移出的若正是当前选中的中心仓库，一并清空该选中项（否则会留下悬空的当前值）。
//
// 移出一个本就不在列表里的路径**不算错误**——这保持了操作的幂等性
// （agent-workflow.md 把「重复执行安全」列为可依赖契约）。
// 而且面板的项目下拉是「已登记仓库 ∪ 候选目录」，用户完全可能去移除一个
// 只是仓库、从未成为候选的目录，报错会让那个按钮看起来是坏的。
export async function removeCandidate(kind, path) {
  const key = candidateKey(kind);
  return mutateStore((s) => {
    const abs = resolve(String(path));
    s.settings[key] = s.settings[key].filter((p) => p.toLowerCase() !== abs.toLowerCase());
    if (kind === 'central' && samePath(s.settings.skillCentralPath, abs)) {
      s.settings.skillCentralPath = '';
    }
    return [...s.settings[key]];
  });
}
