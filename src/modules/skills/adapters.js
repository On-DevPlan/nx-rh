// 平台适配器表：各 AI 编码工具读取 skill 的目录约定。
//
// universal: 直接读 .agents/skills，无需为它建链接（vercel skills 的核心概念）。
// 这张表是唯一真相源——Web 下拉、CLI 的 --adapter 校验、目录扫描全部由它派生。
export const ADAPTERS = [
  { id: 'claude-code', name: 'Claude Code', dir: '.claude/skills', globalDir: '.claude/skills', universal: false },
  { id: 'agents', name: 'Universal (.agents)', dir: '.agents/skills', globalDir: '.agents/skills', universal: true },
  { id: 'cursor', name: 'Cursor', dir: '.cursor/skills', globalDir: '.cursor/skills', universal: false },
  { id: 'codex', name: 'Codex', dir: '.codex/skills', globalDir: '.codex/skills', universal: false },
  { id: 'gemini-cli', name: 'Gemini CLI', dir: '.gemini/skills', globalDir: '.gemini/skills', universal: false },
  { id: 'copilot', name: 'GitHub Copilot', dir: '.copilot/skills', globalDir: '.copilot/skills', universal: false },
  { id: 'windsurf', name: 'Windsurf', dir: '.windsurf/skills', globalDir: '.codeium/windsurf/skills', universal: false },
  { id: 'codebuddy', name: 'CodeBuddy', dir: '.codebuddy/skills', globalDir: '.codebuddy/skills', universal: false },
  { id: 'iflow-cli', name: 'iFlow CLI', dir: '.iflow/skills', globalDir: '.iflow/skills', universal: false },
];

export function listAdapters() {
  return ADAPTERS.map((a) => ({ ...a }));
}
