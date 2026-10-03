// 平台适配器表：各 AI 编码工具读取 skill 的目录约定。
//
// 表里有两条信息，分别决定「订阅源怎么解析」与「迁移落到哪」：
//   dir       —— 项目级目录（相对项目根），如 .claude/skills
//   globalDir —— 用户级目录（相对 home），如 .claude/skills
//
// 这张表是唯一真相源——Web 下拉、CLI 的 --platform 校验、目标目录解析全部由它派生。
import { homedir } from 'node:os';
import { join } from 'node:path';

export const ADAPTERS = [
  // 默认聚焦的两个平台排在最前
  { id: 'claude-code', name: 'Claude Code', dir: '.claude/skills', globalDir: '.claude/skills' },
  { id: 'workbuddy', name: 'WorkBuddy', dir: '.workbuddy/skills', globalDir: '.workbuddy/skills' },
  // 其余平台保留，可按需在“平台范围”里启用
  { id: 'agents', name: 'Universal (.agents)', dir: '.agents/skills', globalDir: '.agents/skills', universal: true },
  { id: 'codebuddy', name: 'CodeBuddy', dir: '.codebuddy/skills', globalDir: '.codebuddy/skills' },
  { id: 'cursor', name: 'Cursor', dir: '.cursor/skills', globalDir: '.cursor/skills' },
  { id: 'codex', name: 'Codex', dir: '.codex/skills', globalDir: '.codex/skills' },
  { id: 'gemini-cli', name: 'Gemini CLI', dir: '.gemini/skills', globalDir: '.gemini/skills' },
  { id: 'copilot', name: 'GitHub Copilot', dir: '.copilot/skills', globalDir: '.copilot/skills' },
  { id: 'windsurf', name: 'Windsurf', dir: '.windsurf/skills', globalDir: '.codeium/windsurf/skills' },
  { id: 'iflow-cli', name: 'iFlow CLI', dir: '.iflow/skills', globalDir: '.iflow/skills' },
];

// 迁移的两个作用域。user = 全局（~/），project = 当前项目根。
// CLI 的 --to 同时接受 global（= user，用户口头语）与 project。
export const SCOPES = [
  { id: 'user', name: '用户级' },
  { id: 'project', name: '项目级' },
];

// 平台别名：命令行里大家写的是 `.claude` / `.workbuddy` / `.cursor` 这种自然名，
// 不该逼人记 `claude-code` 这种 id。别名在这里归一，**唯一真相源仍是 ADAPTERS**。
const PLATFORM_ALIASES = {
  claude: 'claude-code',
  'claude-code': 'claude-code',
  cc: 'claude-code',
  workbuddy: 'workbuddy',
  wb: 'workbuddy',
  codebuddy: 'codebuddy',
  cb: 'codebuddy',
  cursor: 'cursor',
  codex: 'codex',
  gemini: 'gemini-cli',
  'gemini-cli': 'gemini-cli',
  copilot: 'copilot',
  windsurf: 'windsurf',
  iflow: 'iflow-cli',
  'iflow-cli': 'iflow-cli',
  agents: 'agents',
  universal: 'agents',
};

// 归一化平台标识：接受 id、别名、'all'。认不出返回 ''（调用方据此报「未知平台」，
// 并把可选项列出来——比抛一个裸错好定位）。
export function normalizePlatformId(input) {
  if (!input) return '';
  const k = String(input).trim().toLowerCase();
  if (k === 'all') return 'all';
  if (PLATFORM_ALIASES[k]) return PLATFORM_ALIASES[k];
  return ADAPTERS.some((a) => a.id === k) ? k : '';
}

export function listAdapters() {
  return ADAPTERS.map((a) => ({ ...a }));
}

export function adapterById(input) {
  const id = normalizePlatformId(input);
  if (!id || id === 'all') return null;
  return ADAPTERS.find((a) => a.id === id) || null;
}

export function platformNames() {
  return ADAPTERS.map((a) => a.id);
}

// 解析一次迁移的落点目录（绝对路径）。
// scope=user → ~/<globalDir>；scope=project → <projectRoot>/<dir>。
export function targetDirFor(adapterId, scope, projectRoot) {
  const a = adapterById(adapterId);
  if (!a) return null;
  return scope === 'user' ? join(homedir(), a.globalDir) : join(projectRoot, a.dir);
}
