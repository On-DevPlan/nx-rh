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
  // 豆包：用户级落点是「非隐藏 + 首字母大写」的 ~/Doubao/skills（与 ~/Doubao/chats 同级），
  // 不同于其它平台的 ~/.<id>/skills 隐藏目录约定；项目级仍走隐藏目录 .doubao/skills。
  { id: 'doubao', name: 'Doubao（豆包）', dir: '.doubao/skills', globalDir: 'Doubao/skills' },
  // 千问办公（QwenWork）：官方文档只写明用户级 ~/.qwenworkcn/skills（每个 skill 一个含
  // SKILL.md 的子目录），**没有项目级约定**——这里的 dir 是按 .<id>/skills 惯例给的占位，
  // 迁到项目级千问读不到，要真正生效请走用户级（--to global）。
  { id: 'qianwen', name: 'Qianwen（千问办公）', dir: '.qwenworkcn/skills', globalDir: '.qwenworkcn/skills' },
  // Trae 国内版：用户级 ~/.trae-cn/skills（本机实测），但项目级两版共用 .trae/skills
  // （project-graph 仓库里就有三个带 SKILL.md 的实体）。国际版按同族约定是 ~/.trae/skills，
  // 本机未装未实测——真要聚焦国际版再加一行 id=trae 的适配器即可。
  { id: 'trae-cn', name: 'Trae CN（国内版）', dir: '.trae/skills', globalDir: '.trae-cn/skills' },
  // Qoder（阿里，分国际版 qoder.com 与中国版 qoder.cn）：两级目录同名 .qoder/skills，官方文档
  // 两级都写明（项目级优先级最高）；用户级本机实测（~/.qoder/skills，24 个带 SKILL.md 的实体）。
  // 中国版落点未实测也无文档佐证——真要聚焦中国版再加一行 id=qoder-cn 的适配器即可。
  { id: 'qoder', name: 'Qoder', dir: '.qoder/skills', globalDir: '.qoder/skills' },
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
  doubao: 'doubao',
  qianwen: 'qianwen',
  qwenwork: 'qianwen', // 产品英文名 QwenWork
  qwen: 'qianwen',
  qw: 'qianwen',
  'trae-cn': 'trae-cn',
  trae: 'trae-cn', // 本机只装国内版，裸 trae 就落到它；若哪天加了 id=trae 需重新斟酌这条
  qoder: 'qoder',
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
