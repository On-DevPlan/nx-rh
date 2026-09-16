// Skill 模块：中心仓库 <-> 项目两侧的识别、同步、冲突、平台开关、多选比较。
import * as service from './service.js';
import { listAdapters } from './adapters.js';
import { merge3 } from '../../core/diff.js';

// 默认 central：历史 HTTP 行为是 `side || 'central'`（CLI 则要求显式给出）。
// 统一成有默认值，两边都不会因为漏传而失败，也不会一方 200 一方 400。
const SIDE = { type: 'string', enum: ['central', 'project'], default: 'central' };

// ---- CLI 人读渲染 ----

function renderSkillList(list, ctx) {
  if (!list.length) return `（${ctx.side} 侧暂无 skill）`;
  const lines = [`${ctx.side} 侧 ${list.length} 个 skill`];
  for (const s of list) {
    const link = s.linkType ? `链接=${s.linkType}` : '实体';
    const adapter = s.adapter ? `adapter=${s.adapter}` : '';
    lines.push(`${s.name.padEnd(20)} ${s.description.slice(0, 40)}  ${link}  ${adapter}`.trimEnd());
  }
  return lines.join('\n');
}

function renderSyncResult(r) {
  if (r.status === 'conflict') {
    const files = (r.files || []).map((f) => `  ${f.file}  ${f.side}`).join('\n');
    return `冲突: ${r.files.length} 个文件不一致\n${files}\n用 --force 覆盖，或 skill apply 按文件选侧`;
  }
  if (r.skipped) return `已是链接，跳过: ${r.path}`;
  let msg = `已同步 -> ${r.path}（${r.mode === 'symlink' ? '软链接 ' + (r.linkType || '') : '复制'}）`;
  if (r.degraded) msg += `\n注意: 链接创建失败已降级复制（${r.degradedReason || '权限'}）`;
  return msg;
}

function renderConflict(d) {
  if (!d.files.length) return '两侧一致，无差异';
  const lines = [`${d.name}: ${d.files.length} 个文件差异`];
  for (const f of d.files) {
    lines.push(`\n== ${f.file} (${f.side}) ==`);
    if (f.diff) lines.push(f.diff);
  }
  return lines.join('\n');
}

const STATE_MARK = {
  same: '一致',
  linked: '链接',
  differ: '冲突',
  'only-central': '仅中心',
  'only-project': '仅项目',
};

function renderCompare(d) {
  const s = d.summary;
  const lines = [
    `比较: ${d.central}  <->  ${d.project}`,
    `共 ${s.total} 项 · 一致 ${s.same} · 链接 ${s.linked} · 冲突 ${s.differ} · 仅中心 ${s.onlyCentral} · 仅项目 ${s.onlyProject}`,
  ];
  for (const r of d.rows) {
    const plat = r.platforms.length ? `  [${r.platforms.map((p) => p.id).join(',')}]` : '';
    lines.push(`  ${r.name.padEnd(28)} ${STATE_MARK[r.state]}${plat}`);
  }
  return lines.join('\n');
}

export default {
  id: 'skills',
  title: 'Skill 同步（= Web「Skill」页）',
  order: 20,
  view: () => import('./view.jsx'),

  actions: [
    {
      id: 'skill.adapters',
      cli: ['skill', 'adapters'],
      http: ['GET', '/api/skills/adapters'],
      summary: '适配器（平台目录）清单',
      run: () => listAdapters(),
      render: (list) =>
        list.map((a) => `${a.id.padEnd(12)} ${a.dir}  ${a.universal ? '(universal)' : ''}`).join('\n'),
    },
    {
      id: 'skill.list',
      // `skill scan` 是历史别名，与 `skill list` 同义
      cli: [['skill', 'list'], ['skill', 'scan']],
      http: ['GET', '/api/skills'],
      summary: '识别某一侧的 skill（--side central|project）',
      flags: { side: SIDE, path: { type: 'string' } },
      run: (ctx) => service.listSkills(ctx.side, ctx.path),
      render: renderSkillList,
    },
    {
      id: 'skill.sync',
      cli: ['skill', 'sync'],
      http: ['POST', '/api/skills/sync'],
      summary: '中心 -> 项目同步（软链接或复制）',
      args: ['name'],
      flags: {
        project: { type: 'string', required: true },
        mode: { type: 'string', enum: ['symlink', 'copy'] },
        adapter: { type: 'string' },
        force: { type: 'boolean' },
      },
      run: (ctx) => service.syncSkill(ctx),
      render: renderSyncResult,
    },
    {
      id: 'skill.push',
      cli: ['skill', 'push'],
      http: ['POST', '/api/skills/push'],
      summary: '项目 -> 中心推送',
      args: ['name'],
      flags: { project: { type: 'string', required: true }, force: { type: 'boolean' } },
      run: (ctx) => service.pushSkill(ctx),
      render: (d) =>
        d.status === 'ok'
          ? d.skipped
            ? d.reason
            : `已推送到中心: ${d.path}`
          : `冲突: ${d.files.length} 个文件\n用 --force 覆盖，或 skill apply 选侧`,
    },
    {
      id: 'skill.conflict',
      cli: ['skill', 'conflict'],
      http: ['GET', '/api/skills/conflict'],
      summary: '逐文件差异（含 diff 文本）',
      args: ['name'],
      flags: { project: { type: 'string', required: true } },
      run: (ctx) => service.skillConflict(ctx),
      render: renderConflict,
    },
    {
      id: 'skill.apply',
      cli: ['skill', 'apply'],
      http: ['POST', '/api/skills/apply'],
      summary: '按文件选侧落地（central | project）',
      args: ['name'],
      flags: {
        project: { type: 'string', required: true },
        file: { type: 'string', required: true },
        side: { type: 'string', required: true, enum: ['central', 'project'] },
      },
      run: (ctx) => service.applySkillSide(ctx),
      render: (d) => `已按 ${d.side} 侧落地: ${d.file}`,
    },
    {
      id: 'skill.materialize',
      cli: ['skill', 'materialize'],
      http: ['POST', '/api/skills/materialize'],
      summary: '把链接转换为实体目录',
      args: ['name'],
      flags: { project: { type: 'string', required: true } },
      run: (ctx) => service.materializeSkill(ctx),
      render: (d) => (d.converted ? `已转换为实体文件（源: ${d.source}）` : d.message),
    },
    {
      id: 'skill.remove',
      cli: ['skill', 'remove'],
      http: ['POST', '/api/skills/remove'],
      summary: '从项目删除 skill（所有平台目录）',
      args: ['name'],
      flags: { project: { type: 'string', required: true } },
      run: (ctx) => service.removeProjectSkill(ctx),
      render: (d, ctx) => {
        if (!d.removed.length) return d.reason;
        const anchorNote = d.anchor?.converted
          ? `\n已自动物化「${d.anchor.converted.name}」作为实体锚点`
          : '';
        return `已从项目删除 ${ctx.name}（${d.removed.map((x) => x.platform).join(', ')}）${anchorNote}`;
      },
    },
    {
      id: 'skill.platformStatus',
      cli: ['skill', 'platform-status'],
      http: ['GET', '/api/skills/platform'],
      summary: '查询某 skill 在各平台下的存在形态',
      args: ['name'],
      flags: { project: { type: 'string', required: true } },
      run: (ctx) => service.platformStatus(ctx),
      render: (d) =>
        d.platforms
          .map((p) => `${p.on ? '开' : '关'}  ${p.id.padEnd(12)} ${p.linkType || (p.on ? '实体' : '')}`)
          .join('\n'),
    },
    {
      id: 'skill.platformSet',
      cli: ['skill', 'platform-set'],
      http: ['POST', '/api/skills/platform'],
      summary: '开启 / 关闭某个平台（--off 关闭）',
      args: ['name'],
      flags: {
        project: { type: 'string', required: true },
        adapter: { type: 'string', required: true },
        mode: { type: 'string', enum: ['symlink', 'copy'] },
        force: { type: 'boolean' },
        off: { type: 'boolean' },
      },
      // CLI 用 --off 表达关闭，面板直接给 enabled。二者只应有一个出现，
      // 缺省的一方**绝不能覆盖**另一方——曾经写成 `enabled: !ctx.off`，
      // 面板传来的 false 被 !undefined 顶成 true，于是「关闭平台」永远关不掉。
      run: (ctx) => {
        const enabled = ctx.off === true ? false : ctx.enabled !== undefined ? ctx.enabled : true;
        return service.setPlatform({ ...ctx, enabled });
      },
      render: (d) => {
        if (d.status === 'blocked') return `已阻止: ${d.reason}`;
        if (d.removed) return `已关闭平台 ${d.platform}: ${d.path}`;
        if (d.status === 'conflict') return `冲突（${d.platform}）: ${d.files.length} 个文件不同，加 --force 覆盖`;
        if (d.skipped) return `已是该平台的最新链接，跳过（${d.platform}）`;
        return `已开启平台 ${d.platform}（${d.mode === 'symlink' ? '软链接 ' + (d.linkType || '') : '复制'}）`;
      },
    },
    {
      id: 'skill.compare',
      cli: ['skill', 'compare'],
      http: ['POST', '/api/skills/compare'],
      summary: '多选比较中心与项目两侧',
      flags: {
        project: { type: 'string', required: true },
        central: { type: 'string' },
        names: { type: 'array' },
      },
      run: (ctx) => service.compareSkills(ctx),
      render: renderCompare,
    },
    {
      id: 'skill.merge',
      cli: ['skill', 'merge'],
      http: ['POST', '/api/util/merge'],
      summary: 'diff3-lite 三方合并原语（CLI 传文件路径，HTTP 传文本）',
      flags: {
        base: { type: 'string', required: true },
        a: { type: 'string', required: true },
        b: { type: 'string', required: true },
        labelA: { type: 'string' },
        labelB: { type: 'string' },
      },
      // 两端入参形态本质不同：CLI 面向文件（agent 手上有路径），
      // HTTP 面向文本（调用方已在内存里有内容）。这里显式分支，不做勉强的统一。
      run: async (ctx, meta) => {
        if (meta.transport === 'http') {
          return merge3(ctx.base, ctx.a, ctx.b, {
            a: ctx.labelA || 'ours',
            b: ctx.labelB || 'theirs',
          });
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
