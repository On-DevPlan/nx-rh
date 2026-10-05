// 迁移目标：to × platform → 目标目录列表的归一，以及适配器总表的解析。
import { badInput } from '../../../core/errors.js';
import { projectRoot } from '../../../core/paths.js';
import { ADAPTERS, SCOPES, adapterById, targetDirFor, platformNames } from '../adapters.js';
import { getSettings } from '../../settings/service.js';
import { scanSkillsRoot } from './scan.js';

export const SCOPE_IDS = SCOPES.map((s) => s.id);

// 把 to/platform 归一成目标列表 [{platform, platformName, scope, dir}]
// to 接受 global（= user）/ project / all；platform 接受 id 或别名（claude / workbuddy / cursor…）
export async function resolveTargets({ to, platform, project } = {}) {
  const s = await getSettings();
  // 项目根缺省取「启动目录」（serve <dir> / cwd，或面板回传的 x-nx-rh-scope）
  const projRoot = project || projectRoot();
  const toId = to === 'global' ? 'user' : to;
  const scopes = toId && toId !== 'all' ? [toId] : SCOPE_IDS;
  for (const sc of scopes) {
    if (!SCOPE_IDS.includes(sc)) {
      throw badInput('to 只能是 user | global | project | all，收到: ' + to);
    }
  }
  let platformIds;
  if (platform && platform !== 'all') {
    const a = adapterById(platform);
    if (!a) throw badInput(`未知平台: ${platform}（可用: ${platformNames().join(' / ')}，或别名 claude / wb）`);
    platformIds = [a.id];
  } else {
    platformIds = s.platforms.length ? s.platforms : ['claude-code'];
  }
  const list = [];
  for (const sc of scopes) {
    for (const pid of platformIds) {
      const a = adapterById(pid);
      if (!a) throw badInput('未知平台: ' + pid);
      const dir = targetDirFor(a.id, sc, projRoot);
      list.push({ platform: a.id, platformName: a.name, scope: sc, dir });
    }
  }
  return list;
}

// 扫描目标目录，返回该目录下的所有 skill（含形态）
export async function scanTargetDir(dir, { platform, scope }) {
  const skills = await scanSkillsRoot(dir);
  for (const s of skills) {
    s.platform = platform;
    s.scope = scope;
  }
  return skills;
}

// 适配器总表：带上**解析后的绝对安装位置**，这样「把一个 skill 变成 .claude / .workbuddy / .cursor」
// 在 CLI 上就是可读、可抄的——不必先起面板再猜目录。
export async function adaptersInfo({ project } = {}) {
  const s = await getSettings();
  const projRoot = project || projectRoot();
  return ADAPTERS.map((a) => ({
    ...a,
    enabled: s.platforms.includes(a.id),
    isDefault: s.defaultPlatform === a.id,
    userDir: targetDirFor(a.id, 'user'),
    projectDir: targetDirFor(a.id, 'project', projRoot),
  }));
}
