// 内置 skill 包模块：把随包发布的 repo-hub 说明装到用户的 skills 目录。
// 没有面板视图——安装入口在 Skill 页，列出/安装都通过 action 暴露。
import * as service from './service.js';

export default {
  id: 'bundled',
  title: '内置 skill 包',
  order: 50,
  view: null,

  actions: [
    {
      id: 'bundled.list',
      // 第二条是历史别名：`skill install --list` 早于 `bundled list` 存在，
      // 命令路径里带 flag，因此匹配是按 token 前缀而非「非 flag 前缀」。
      cli: [['bundled', 'list'], ['skill', 'install', '--list']],
      http: ['GET', '/api/bundled'],
      summary: '列出包内自带 skill（含文件数与描述）',
      // 两端返回结构刻意不同：HTTP 供面板顺带拿到默认安装目录；
      // CLI 的 --json 保持纯数组的历史形状，不破坏已在消费它的 agent。
      run: async (_ctx, meta) => {
        const skills = await service.listBundledSkills();
        return meta.transport === 'http'
          ? { defaultDir: service.DEFAULT_SKILLS_DIR, skills }
          : skills;
      },
      render: (l) =>
        l.length
          ? l.map((s) => `${s.name.padEnd(14)} ${s.files} 个文件  ${s.description.slice(0, 50)}`).join('\n')
          : '（包内无内置 skill）',
    },
    {
      id: 'bundled.install',
      cli: ['skill', 'install'],
      http: ['POST', '/api/bundled/install'],
      summary: '安装内置 skill 到 skills 目录（默认 repo-hub → ~/.claude/skills）',
      args: [{ name: 'name', required: false }],
      flags: { to: { type: 'string' }, force: { type: 'boolean' } },
      run: (ctx) =>
        service.installBundledSkill({ name: ctx.name || 'repo-hub', to: ctx.to, force: ctx.force }),
      render: (d) => {
        if (d.status === 'conflict') {
          const files = d.files.map((f) => `  ${f.file}  ${f.side}`).join('\n');
          return `目标已存在且内容不同（${d.count} 个文件）: ${d.path}\n${files}\n用 --force 覆盖，或先删除目标目录`;
        }
        if (d.skipped) return `已是最新，无需安装: ${d.path}`;
        return `${d.replaced ? '已更新' : '已安装'} ${d.name}（${d.files} 个文件）-> ${d.path}`;
      },
    },
  ],
};
