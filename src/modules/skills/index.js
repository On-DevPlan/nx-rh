// Skill 模块：订阅源（Skill Hub）→ 平台目录的迁移、回迁、提交、上下文导出。
//
// 本文件只做 action 声明（cli + http + run）；人读渲染在 renders.js，
// 业务在 service.js（barrel）与 svc/。一条 action 同时声明 cli 与 http，
// 命令表/路由表/help 全部由此派生。
import * as service from './service.js';
import { merge3 } from '../../core/diff.js';
import { projectRoot } from '../../core/paths.js';
import { badInput } from '../../core/errors.js';
import {
  SCOPE_MARK,
  sourceLabel,
  sourceLabels,
  renderAdapters,
  renderSkillList,
  renderSources,
  renderProjectList,
  renderShow,
  renderMigrate,
  renderUnmigrate,
  renderSubmit,
  renderPurge,
} from './renders.js';

// `--to`：user（用户级 ~/）· global（= user，口头语）· project（项目级，缺省）· all（两者）
const TO = { type: 'string', enum: ['user', 'global', 'project', 'all'], default: 'project' };
// 项目根统一取「启动目录 / 面板回传的作用域」，显式 --project 覆盖
const projectOf = (ctx) => ctx.project || projectRoot();

// 批量选择的公共参数（migrate / unmigrate / submit 共用）。
// 全量迁移的真需求是「全都要，除了某几个」——所以 --exclude 是一等参数。
const SELECT = {
  all: { type: 'boolean' },
  include: { type: 'array', hint: '模式' },
  exclude: { type: 'array', hint: '模式' },
  match: { type: 'string', hint: '描述关键词' },
  'dry-run': { type: 'boolean' },
};

// 至少要给出一种选择方式：点名 / --all / --include
function hasSelection(ctx) {
  const names = Array.isArray(ctx.name) ? ctx.name : ctx.name ? [ctx.name] : [];
  return names.length > 0 || ctx.all === true || (Array.isArray(ctx.include) ? ctx.include.length > 0 : !!ctx.include);
}

const SELECT_USAGE = '<name...> | --all | --include <模式>（可叠加 --exclude <模式> / --match <描述关键词>）';

export default {
  id: 'skills',
  title: 'Skill（= Web「Skill」页）',
  order: 20,
  view: () => import('./view.jsx'),

  actions: [
    // ---- 平台适配器 ----
    {
      id: 'skill.adapters',
      cli: [['skill', 'hub', 'adapters'], ['skill', 'adapters']],
      http: ['GET', '/api/skills/adapters'],
      summary: '平台适配器清单（每平台的项目级 / 用户级绝对安装位置）',
      flags: { project: { type: 'string' } },
      run: (ctx) => service.adaptersInfo({ project: projectOf(ctx) }),
      render: renderAdapters,
    },

    // ---- 订阅源（Skill Hub）----
    {
      id: 'skill.sources',
      cli: [['skill', 'hub', 'sources'], ['skill', 'sources']],
      http: ['GET', '/api/skills/sources'],
      summary: '订阅源清单（* 为当前主源）',
      run: () => service.listSources(),
      render: renderSources,
    },
    {
      id: 'skill.hub.add',
      cli: ['skill', 'hub', 'subscribe'],
      http: ['POST', '/api/skills/sources'],
      summary: '订阅一个 skill 目录（并设为主源）',
      args: ['path'],
      run: async (ctx) => {
        const d = await service.addSource(ctx.path);
        return { path: ctx.path, ...d };
      },
      render: (d) => `已订阅: ${d.path}`,
    },
    {
      id: 'skill.hub.remove',
      cli: ['skill', 'hub', 'unsubscribe'],
      http: ['DELETE', '/api/skills/sources'],
      summary: '取消订阅（不动磁盘）',
      args: ['path'],
      run: (ctx) => service.removeSource(ctx.path),
      render: (d) => `已取消订阅，剩余 ${d.sources.length} 个`,
    },
    {
      id: 'skill.hub',
      cli: [['skill', 'hub', 'main'], ['skill', 'hub']],
      http: null,
      summary: '查看 / 设置当前主订阅源',
      args: [{ name: 'path', required: false }],
      run: async (ctx) => {
        if (ctx.path) return service.setSource(ctx.path);
        const info = await service.hubInfo();
        return info.path || '（未订阅）';
      },
      render: (d, ctx) => (ctx.path ? `当前主源: ${d.current || ctx.path}` : String(d)),
    },
    {
      // 订阅源是唯一可信源，所以来源之间本不该有冲突——这是「订阅配置」的诊断，
      // 不是 skill 内容的诊断。目的仓库直接被覆盖，不参与冲突检测。
      id: 'skill.hub.check',
      cli: ['skill', 'hub', 'check'],
      http: ['GET', '/api/skills/hub-check'],
      summary: '订阅源健康检查：目录缺失 / 空源 / 嵌套订阅 / 重复根 / 跨源同名冲突',
      run: () => service.sourceAudit(),
      render: (d) => {
        if (d.ok) return `订阅源健康：${d.summary.sources} 个来源，无冲突、无重复`;
        const lines = [`订阅源有问题（${d.summary.sources} 个来源）:`];
        for (const p of d.hubProblems) lines.push(`  ! ${p.reason}  —— ${p.path}`);
        for (const c of d.conflicts.filter((x) => !x.same)) {
          lines.push(`  ! 跨源冲突: ${c.name}`);
          const all = c.entries.map((e) => e.source);
          for (const e of c.entries) lines.push(`      ${sourceLabel(e.source, all)}  ${e.md5.slice(0, 8)}  ${e.dir}`);
        }
        for (const c of d.conflicts.filter((x) => x.same)) {
          lines.push(`  · 重复订阅（内容一致）: ${c.name} —— ${sourceLabels(c.entries)}`);
        }
        lines.push('');
        lines.push('处理：取消订阅多余来源（skill hub remove）；真冲突保留一份实文件后再迁移。');
        return lines.join('\n');
      },
    },

    // ---- 列表 / 详情 / 上下文 ----
    {
      id: 'skill.list',
      // `skill scan` 是历史别名，与 `skill list` 同义
      cli: [['skill', 'hub', 'list'], ['skill', 'scan']],
      http: ['GET', '/api/skills'],
      summary: '列出订阅源 skill（名称 / 来源目录 / 描述 + 各目标迁移状态）',
      flags: {
        project: { type: 'string' }, source: { type: 'string' },
        platform: { type: 'string' }, long: { type: 'boolean' },
      },
      run: (ctx) => service.listAllSkills({
        project: projectOf(ctx), source: ctx.source, platform: ctx.platform,
      }),
      render: renderSkillList,
    },
    {
      id: 'skill.show',
      cli: [['skill', 'hub', 'show'], ['skill', 'show'], ['skill', 'describe']],
      http: ['GET', '/api/skills/detail'],
      summary: '查看单个 skill：完整描述 + 来源目录 + 各平台安装状态与当前形态',
      args: ['name'],
      flags: { project: { type: 'string' } },
      run: (ctx) => service.skillInfo({ name: ctx.name, project: projectOf(ctx) }),
      render: renderShow,
    },
    {
      // skill 的全文导出。注意与 bundled 的 `skill get` 分工：
      // get = 内置手册（repo-hub 之外的「本工具说明书」，三段拼接 + 顺手安装）；
      // cat = 任意 skill 的全文（给外部 agent 当业务上下文）。
      // 订阅源与**不在订阅源的平台副本**都读得到 —— 后者从前只查订阅源，必然 NOT_FOUND。
      id: 'skill.cat',
      cli: [['skill', 'hub', 'cat'], ['skill', 'cat']],
      http: ['GET', '/api/skills/content'],
      summary: '输出 skill 全文（SKILL.md 或 --ref <相对路径>），订阅源与不在订阅源的平台副本都能读',
      args: ['name'],
      flags: { ref: { type: 'string', hint: 'skill 内相对路径，如 references/api.md' }, project: { type: 'string' } },
      run: (ctx) => service.skillContent({ name: ctx.name, ref: ctx.ref, project: projectOf(ctx) }),
      // 三段拼接：引导语 → 正文 → 后续动作提示。--json 走纯数据，不打这些。
      render: (d) => {
        const bar = '─'.repeat(60);
        const where = d.source ? `来源: ${d.source}` : `目录: ${d.dir}`;
        return [
          `# skill: ${d.skillName}   ${where}`,
          bar,
          d.content.replace(/\s*$/, ''),
          bar,
          `# 需要安装到本机？nx-rh skill hub migrate ${d.skillName} --to user`,
        ].join('\n');
      },
    },

    // ---- skill 实体的增改删（只动订阅源那份实文件） ----
    {
      id: 'skill.add',
      cli: [['skill', 'hub', 'add'], ['skill', 'add']],
      http: ['POST', '/api/skills'],
      summary: '在订阅源新建一个 skill（已存在同名则报冲突）',
      args: [{ name: 'name', required: true }],
      flags: { description: { type: 'string' }, content: { type: 'string' } },
      run: (ctx) => service.addSkill(ctx),
      render: (d) => `已创建: ${d.path}`,
    },
    {
      id: 'skill.update',
      cli: [['skill', 'hub', 'update'], ['skill', 'update']],
      http: ['PATCH', '/api/skills/:name'],
      summary: '改写订阅源 skill 的 SKILL.md 全文（须含 name/description frontmatter）',
      args: ['name'],
      flags: { content: { type: 'string', required: true } },
      run: (ctx) => service.updateSkill({ name: ctx.name, content: ctx.content }),
      render: (d) => `已保存: ${d.dir}\\SKILL.md`,
    },
    {
      id: 'skill.remove',
      cli: [['skill', 'hub', 'remove'], ['skill', 'remove']],
      http: ['DELETE', '/api/skills/:name'],
      summary: '从订阅源删除 skill（目标侧还有引用时返回 blocked，--force 继续）',
      args: ['name'],
      flags: { force: { type: 'boolean' }, project: { type: 'string' } },
      run: (ctx) => service.removeSkill({ name: ctx.name, force: ctx.force, project: projectOf(ctx) }),
      render: (d) => {
        if (d.status === 'blocked') {
          return `已阻止: ${d.reason}\n${d.refs.map((x) => `  ${SCOPE_MARK[x.scope]}·${x.platform} ${x.path}`).join('\n')}\n确认 dangling 再加 --force`;
        }
        return `已删除: ${d.removed}${d.dangling.length ? `（${d.dangling.length} 个目标现为悬空，可用迁移重建）` : ''}`;
      },
    },
    {
      // 与 skill remove 分开：remove 只下架订阅源那份（目标侧还引用就 blocked），
      // purge 是「这个名字不该存在了」——连各平台安装位置一起删。
      // **不在订阅源的 skill 只有这一条路能删**（订阅源里根本没有它，remove 是 NOT_FOUND）。
      id: 'skill.purge',
      cli: [['skill', 'hub', 'purge'], ['skill', 'purge']],
      http: ['POST', '/api/skills/purge'],
      summary: '彻底删除 skill：所有平台安装位置 + 订阅源里的实文件（--dry-run 先看清单）',
      args: ['name'],
      flags: {
        force: { type: 'boolean', hint: '安装位置里有实体副本时必须加（可能含本地改动）' },
        project: { type: 'string' },
        'dry-run': { type: 'boolean', hint: '只列出将删除的路径，不落盘' },
      },
      run: (ctx) => service.purgeSkill({
        name: ctx.name,
        force: ctx.force,
        project: projectOf(ctx),
        dryRun: ctx['dry-run'] === true,
      }),
      render: renderPurge,
    },

    // ---- 迁移 / 撤销 / 提交 / 物化 ----
    {
      id: 'skill.migrate',
      // `skill adapt` 是同一动作的口语别名：把 skill 适配成某平台形态（落到它的目录）
      cli: [['skill', 'hub', 'migrate'], ['skill', 'migrate'], ['skill', 'adapt']],
      http: ['POST', '/api/skills/migrate'],
      summary: '订阅源 → 平台目录（<name...> | --all | --include；--exclude/--match 精筛；--dry-run 预演）',
      args: [{ name: 'name', rest: true, required: false }],
      flags: {
        to: TO,
        platform: { type: 'string' },
        mode: { type: 'string', enum: ['symlink', 'copy'] },
        project: { type: 'string' },
        // 只在「同名 skill 出现在多个订阅源且内容不同」时用：指定采用哪一份
        source: { type: 'string' },
        ...SELECT,
      },
      run: (ctx) => {
        if (!hasSelection(ctx)) throw badInput(`用法: nx-rh skill hub migrate ${SELECT_USAGE}`);
        // CLI flag 名是 --dry-run（连字符），service 参数是 dryRun（驼峰）——在这一处映射
        return service.migrateSkill({ ...ctx, dryRun: ctx['dry-run'] === true, project: projectOf(ctx) });
      },
      render: renderMigrate,
    },
    {
      id: 'skill.unmigrate',
      cli: [['skill', 'hub', 'unmigrate'], ['skill', 'unmigrate']],
      http: ['POST', '/api/skills/unmigrate'],
      summary: '撤销迁移（<name...> | --all | --include；--exclude/--match 精筛；--dry-run 预演）',
      args: [{ name: 'name', rest: true, required: false }],
      flags: {
        to: TO,
        platform: { type: 'string' },
        project: { type: 'string' },
        force: { type: 'boolean' },
        ...SELECT,
      },
      run: (ctx) => {
        if (!hasSelection(ctx)) throw badInput(`用法: nx-rh skill hub unmigrate ${SELECT_USAGE}`);
        return service.unmigrateSkill({ ...ctx, dryRun: ctx['dry-run'] === true, project: projectOf(ctx) });
      },
      render: renderUnmigrate,
    },
    {
      id: 'skill.submit',
      cli: [['skill', 'hub', 'submit'], ['skill', 'submit']],
      http: ['POST', '/api/skills/submit'],
      summary: '平台副本 → 订阅源（<name...> | --all 取「不在订阅源」那批；提交后删除目标实文件）',
      args: [{ name: 'name', rest: true, required: false }],
      flags: {
        // 缺省 all（而不是全局的 project）：不在订阅源的 skill 常常落在**用户级**平台目录里，
        // 只扫项目级会直接报「目标目录里没有该 skill」——`skill submit --all` 正是主推用法。
        to: { ...TO, default: 'all' },
        platform: { type: 'string' },
        project: { type: 'string' },
        force: { type: 'boolean' },
        keepTarget: { type: 'boolean' },
        // 收进**哪个**订阅源（须已订阅；缺省当前主源）。与 migrate 的 --source 刻意区分：
        // source = 用哪个源的内容（来源侧冲突），into = 落到哪个源（提交方向）。
        into: { type: 'string', hint: '收进哪个订阅源（须已订阅；缺省当前主源）' },
        ...SELECT,
      },
      run: (ctx) => {
        if (!hasSelection(ctx)) throw badInput(`用法: nx-rh skill hub submit ${SELECT_USAGE}`);
        return service.submitSkill({ ...ctx, dryRun: ctx['dry-run'] === true, project: projectOf(ctx) });
      },
      render: renderSubmit,
    },
    {
      id: 'skill.materialize',
      cli: [['skill', 'hub', 'materialize'], ['skill', 'materialize']],
      http: ['POST', '/api/skills/materialize'],
      summary: '把目标侧的链接转换为实体副本',
      args: ['name'],
      flags: { to: TO, platform: { type: 'string' }, project: { type: 'string' } },
      run: (ctx) => service.materializeSkill({ ...ctx, project: projectOf(ctx) }),
      render: (d) => (d.converted ? `已转换为实体: ${d.results.map((r) => `${r.scope}·${r.platform}`).join(', ')}` : '（目标侧本就没有链接）'),
    },

    // ---- 设置：平台范围 / 项目目录 ----
    {
      id: 'setting.platforms',
      cli: [['skill', 'hub', 'platform'], ['skill', 'platform']],
      http: null,
      summary: '查看 / 设置启用的平台（首个为默认平台）',
      args: [{ name: 'platforms', rest: true, required: false }],
      run: async (ctx) => {
        const settings = await import('../settings/service.js');
        if (ctx.platforms.length) {
          return settings.updateSettings({ platforms: ctx.platforms, defaultPlatform: ctx.platforms[0] });
        }
        const s = await settings.getSettings();
        return { platforms: s.platforms, defaultPlatform: s.defaultPlatform };
      },
      render: (d) => `平台: ${d.platforms.join(', ')}\n默认: ${d.defaultPlatform}`,
    },
    {
      id: 'skill.project.list',
      cli: [['skill', 'hub', 'project', 'list'], ['skill', 'project', 'list'], ['skill', 'project']],
      http: null,
      summary: '项目目录候选清单',
      run: async () => (await import('../settings/service.js')).listCandidates('project'),
      render: (l) => (l.length ? l.join('\n') : '（暂无项目目录候选，用 skill hub project add <path> 添加）'),
    },
    {
      // cwd 作用域的实体盘点：项目目录里各平台目录下**实际存在**的 skill，
      // 不受「启用平台」裁剪（未启用平台只标注）；inHub 标注是否已在订阅源。
      id: 'skill.project.skills',
      cli: [['skill', 'hub', 'project', 'skills'], ['skill', 'project', 'skills']],
      http: ['GET', '/api/skills/project-skills'],
      summary: '当前项目目录里的 skill（扫全部适配器项目级目录，标注是否已在订阅源）',
      flags: { project: { type: 'string' } },
      run: (ctx) => service.listProjectSkills({ project: projectOf(ctx) }),
      render: renderProjectList,
    },
    {
      id: 'skill.project.add',
      cli: [['skill', 'hub', 'project', 'add'], ['skill', 'project', 'add']],
      http: ['POST', '/api/skills/project'],
      summary: '添加项目目录候选',
      args: ['path'],
      run: async (ctx) => (await import('../settings/service.js')).addCandidate('project', ctx.path),
      render: (l, ctx) => `已添加项目目录（共 ${l.length} 个）: ${l[l.length - 1] ?? ctx.path}`,
    },
    {
      id: 'skill.project.remove',
      cli: [['skill', 'hub', 'project', 'remove'], ['skill', 'project', 'remove']],
      http: ['DELETE', '/api/skills/project'],
      summary: '从候选移除项目目录（不动磁盘）',
      args: ['path'],
      run: async (ctx) => (await import('../settings/service.js')).removeCandidate('project', ctx.path),
      render: (l) => `已移除，剩余 ${l.length} 个`,
    },

    // ---- 通用：三方合并（保留的 diff 原语）----
    {
      id: 'skill.merge',
      cli: [['skill', 'hub', 'merge'], ['skill', 'merge']],
      http: ['POST', '/api/util/merge'],
      summary: 'diff3-lite 三方合并原语（CLI 传文件路径，HTTP 传文本）',
      flags: {
        base: { type: 'string', required: true },
        a: { type: 'string', required: true },
        b: { type: 'string', required: true },
        labelA: { type: 'string' },
        labelB: { type: 'string' },
      },
      run: async (ctx, meta) => {
        if (meta.transport === 'http') {
          return merge3(ctx.base, ctx.a, ctx.b, { a: ctx.labelA || 'ours', b: ctx.labelB || 'theirs' });
        }
        const fsp = await import('node:fs/promises');
        const [base, a, b] = await Promise.all([
          fsp.readFile(ctx.base, 'utf8'),
          fsp.readFile(ctx.a, 'utf8'),
          fsp.readFile(ctx.b, 'utf8'),
        ]);
        return merge3(base, a, b);
      },
      render: (d) => d.merged,
    },
  ],
};
