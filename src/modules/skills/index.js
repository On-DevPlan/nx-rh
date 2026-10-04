// Skill 模块：订阅源（Skill Hub）→ 平台目录的迁移、回迁、提交、上下文导出。
//
// 一条 action 同时声明 cli 与 http，命令表/路由表/help 全部由此派生。
import * as service from './service.js';
import { merge3 } from '../../core/diff.js';
import { projectRoot } from '../../core/paths.js';
import { badInput } from '../../core/errors.js';

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

// ---- CLI 人读渲染 ----

const SCOPE_MARK = { user: '用户', project: '项目' };

function cellText(cells) {
  if (!cells?.length) return '';
  const on = cells.filter((c) => c.on);
  if (!on.length) return '未迁移';
  return on
    .map((c) => `${SCOPE_MARK[c.scope] || c.scope}·${c.platform}${c.linkType ? '(链接)' : '(副本)'}`)
    .join(' ');
}

const pathSegs = (p) => String(p || '').replace(/\\/g, '/').split('/').filter(Boolean);
const lastSeg = (p) => pathSegs(p).slice(-1)[0] || String(p || '');

// 订阅源的展示名（与 src/modules/skills/view.jsx 的 sourceLabel 是同一套算法，改一处要改两处）。
//
// 从前是「取末两段」：`D:\a_other\md\sl\skills` → `sl/skills`。能区分，但每一行都拖着
// 那个毫无信息量的 `skills` 尾巴；而订阅源目录**几乎都叫 skills**，所以这段尾巴在
// 整个列表里重复出现几十次。多源列表里本来就该只留「能区分」的那一小段。
//
// 做法：先剥掉**所有源共有**的尾部段（通常就是 `skills`），再取「最短能唯一区分」的尾部；
// 父目录也重名时继续往上退。all = 全部来源路径（不传就只能退回末段）。
function sourceLabel(p, all) {
  if (!p) return '';
  const uniq = [...new Set([...(all || []), p].filter(Boolean))];
  if (uniq.length < 2) return lastSeg(p);

  const all2 = uniq.map(pathSegs);
  let common = 0;
  const minLen = Math.min(...all2.map((s) => s.length));
  while (common + 1 < minLen) {
    const i = common + 1;
    const tail = all2[0][all2[0].length - i].toLowerCase();
    if (all2.every((s) => s[s.length - i].toLowerCase() === tail)) common += 1;
    else break;
  }
  const pools = all2.map((s) => (s.length > common ? s.slice(0, s.length - common) : s));

  const idx = uniq.indexOf(p);
  const own = pools[idx];
  let n = 1;
  while (n < own.length) {
    const tail = own.slice(-n).join('/').toLowerCase();
    if (!pools.some((o, j) => j !== idx && o.slice(-n).join('/').toLowerCase() === tail)) break;
    n += 1;
  }
  return own.slice(-n).join('/') || lastSeg(p);
}

// 把一组来源渲染成可区分的短名串。来源元素可以是路径字符串，也可以是 {path} / {source}
function sourceLabels(items, sep = ' / ') {
  const all = (items || []).map((x) => (typeof x === 'string' ? x : x.path || x.source));
  return all.map((p) => sourceLabel(p, all)).join(sep);
}

function renderSkillList(d, ctx) {
  const lines = [`订阅源: ${d.hub.path || '（未订阅）'}`];
  for (const s of d.sources || []) {
    lines.push(`  ${s.current ? '*' : ' '} ${s.path}  (${s.count} 个)`);
  }
  lines.push('');
  // 来源侧只认实文件；这里列出**订阅配置**的问题与跨源冲突（与目的仓库无关）
  for (const p of d.hubProblems || []) {
    lines.push(`! ${p.reason}  —— ${p.path}`);
  }
  for (const c of (d.conflicts || []).filter((x) => !x.same)) {
    lines.push(`! 同名 skill 在多个订阅源且内容不同: ${c.name}  —— ${sourceLabels(c.sources)}`);
  }
  for (const c of (d.conflicts || []).filter((x) => x.same)) {
    lines.push(`· 重复订阅（内容一致）: ${c.name}  —— ${sourceLabels(c.sources)}`);
  }
  if ((d.hubProblems || []).length || (d.conflicts || []).length) lines.push('');
  const srcAll = [...new Set(d.skills.map((s) => s.source))];
  const multi = srcAll.length > 1;
  if (!d.skills.length) lines.push('（订阅源里暂无 skill）');
  for (const s of d.skills) {
    if (ctx && ctx.long) {
      // 详细态：完整描述 + 目录 + 迁移现状，一个 skill 一块
      lines.push(s.name);
      lines.push(`  目录: ${s.dir}`);
      lines.push(`  来源: ${s.source}`);
      if (s.alsoIn?.length) lines.push(`  同时存在于: ${s.alsoIn.join(', ')}`);
      lines.push(`  描述: ${s.description}`);
      lines.push(`  迁移: ${cellText(s.cells) || '未迁移'}`);
      lines.push('');
      continue;
    }
    const tag = multi ? `  [${sourceLabel(s.source, srcAll)}]` : '';
    lines.push(`${s.name.padEnd(28)} ${(s.description || '').slice(0, 48)}${tag}`.trimEnd());
  }
  if (d.orphans?.length) {
    lines.push('');
    lines.push(`未入 Hub（${d.orphans.length} 个，可 skill submit 提交）:`);
    for (const o of d.orphans) lines.push(`  ${o.name.padEnd(26)} ${cellText(o.cells)}`);
  }
  if (!ctx || !ctx.long) {
    lines.push('');
    lines.push('（--long 看完整描述与目录；skill hub show <name> 看各平台落点）');
  }
  return lines.join('\n');
}

function renderSources(d) {
  if (!d.sources.length) return '（暂无订阅源，用 nx-rh skill hub subscribe <path> 添加）';
  return d.sources.map((s) => `${s.current ? '*' : ' '} ${s.path}  (${s.count} 个)${s.exists ? '' : '  [目录不存在]'}`).join('\n');
}

function renderMigrate(d) {
  if (!d.dryRun && d.status === 'blocked') {
    const lines = [`已阻止: ${d.blocked.length} 处无法迁移 —— 同名 skill 在多个订阅源且内容不同（来源冲突）`];
    const seen = new Set();
    for (const b of d.blocked) {
      if (seen.has(b.name)) continue;
      seen.add(b.name);
      const all = b.sources.map((s) => s.source);
      lines.push(`  ${b.name.padEnd(28)} ${b.sources.map((s) => `${sourceLabel(s.source, all)}(${s.md5.slice(0, 6)})`).join('  ')}`);
    }
    lines.push('先解决订阅（删掉多余来源），或用 --source <路径> 指定用哪一份。');
    return lines.join('\n');
  }
  const mark = (r) => {
    const where = `${SCOPE_MARK[r.scope] || r.scope}·${r.platform}`;
    if (r.skipped) return `${where} 已是最新`;
    if (d.dryRun) return `${where} ${r.wouldCreate ? '将创建' : '将覆盖'}`;
    const how = r.mode === 'symlink' ? `软链接 ${r.linkType || ''}`.trim() : '复制';
    return `${where} ${how}${r.degraded ? '（链接失败已降级复制）' : ''}`;
  };
  const multi = (d.selected || []).length > 1;
  const head = d.dryRun
    ? `预演（--dry-run，未改动磁盘）: 选中 ${d.selected.length} 个 · 将变更 ${d.wouldChange} 处 · 已是最新 ${d.skipped} 处`
    : `已迁移 ${d.migrated} 处（跳过 ${d.skipped}）· 选中 ${d.selected.length} 个`;
  const lines = [head];
  for (const r of d.results) lines.push(multi ? `  ${String(r.name || '').padEnd(28)} ${mark(r)}` : `  ${mark(r)}`);
  return lines.join('\n');
}

function renderUnmigrate(d) {
  if (d.dryRun) {
    const lines = [`预演（--dry-run，未改动磁盘）: 选中 ${d.selected.length} 个 · 将移除 ${d.plan.length} 处`];
    for (const x of d.plan) lines.push(`  ${String(x.name).padEnd(28)} ${SCOPE_MARK[x.scope]}·${x.platform} ${x.linkType ? '链接' : '实体副本'}`);
    if (!d.plan.length) lines.push('  （这些目标本就没有该 skill）');
    return lines.join('\n');
  }
  if (d.status === 'blocked') {
    const list = d.needForce.map((x) => `  ${SCOPE_MARK[x.scope]}·${x.platform} ${x.path}`).join('\n');
    return `已阻止: ${d.reason}\n${list}`;
  }
  if (!d.removed.length) return '（这些目标本就没有该 skill）';
  const multi = (d.selected || []).length > 1;
  return `已撤销 ${d.removed.length} 处（选中 ${d.selected.length} 个）:\n${d.removed
    .map((x) => (multi
      ? `  ${String(x.name).padEnd(28)} ${SCOPE_MARK[x.scope]}·${x.platform} ${x.linkType ? '链接' : '副本'}`
      : `  ${SCOPE_MARK[x.scope]}·${x.platform} ${x.linkType ? '链接' : '副本'}`))
    .join('\n')}`;
}

function renderSubmit(d) {
  if (!d.dryRun && d.status === 'conflict') {
    const c = d.conflicts[0];
    return `订阅源里已存在同名 skill 且内容不同（${c.files.length} 个文件）: ${c.path}\n用 --force 覆盖`;
  }
  // 批量形状（count 字段是新增的；单个提交走旧形状）
  if (d.count !== undefined) {
    if (d.dryRun) {
      const lines = [`预演（--dry-run，未改动磁盘）: 选中 ${d.selected.length} 个 · 将提交 ${d.wouldSubmit} 个`];
      for (const r of d.results) {
        lines.push(`  ${String(r.name).padEnd(28)} ${r.status === 'ok' ? '将收进订阅源并改回链接' : r.reason || r.status}`);
      }
      return lines.join('\n');
    }
    const lines = [`已提交 ${d.submitted} 个到订阅源（跳过 ${d.skipped} · 目标缺失 ${d.missing}）`];
    for (const r of d.results) {
      lines.push(`  ${String(r.name).padEnd(28)} ${r.status === 'ok' ? `→ ${r.sourceDir}` : r.reason || r.status}`);
    }
    return lines.join('\n');
  }
  if (d.skipped) return d.reason;
  return `已提交到订阅源: ${d.sourceDir}\n目标实文件已删除${d.relinked ? `，改回链接（${d.relinked}）` : '（未重建链接）'}`;
}

function renderShow(d) {
  const lines = [d.name];
  lines.push(`  来源: ${d.source || '（不在订阅源，可 skill submit）'}`);
  if (d.dir) lines.push(`  目录: ${d.dir}`);
  if (d.alsoIn?.length) lines.push(`  同时存在于: ${d.alsoIn.join(', ')}`);
  lines.push(`  描述: ${d.description}`);
  if (d.outline?.length) {
    lines.push(`  结构（${d.stats?.sections ?? d.outline.length} 节 · ${d.stats?.lines ?? '?'} 行）:`);
    for (const h of d.outline) lines.push(`    ${'  '.repeat(h.level - 1)}${'#'.repeat(h.level)} ${h.text}`);
  }
  if (d.conflict && !d.conflict.same) {
    lines.push(`  ! 跨源冲突: 同名 skill 在多个订阅源且内容不同（${sourceLabels(d.conflict.sources)}）`);
    lines.push('    迁移会 blocked，先解决订阅或用 --source <路径> 指定用哪一份。');
  } else if (d.conflict) {
    lines.push(`  · 重复订阅（内容一致）: ${sourceLabels(d.conflict.sources)}`);
  }
  lines.push('  平台落点（skill hub migrate <name> --platform <id> --to user|global|project）：');
  for (const c of d.cells) {
    const head = `${SCOPE_MARK[c.scope] || c.scope}·${c.platformName || c.platform}`;
    lines.push(`    ${head.padEnd(22)} ${c.on ? c.linkType || '实体副本' : '未迁移'}  ${c.dir}`);
  }
  if (d.alsoIn?.length) {
    lines.push('');
    lines.push('  提示：同名 skill 出现在多个订阅源里，迁移以「当前主源」为准。');
  }
  return lines.join('\n');
}

function renderPurge(d) {
  const lines = [];
  if (d.status === 'blocked') lines.push(`已阻止: ${d.reason}`);
  else if (d.dryRun) lines.push(`预演（--dry-run，未改动磁盘）: 将彻底删除 ${d.plan.name}`);
  else lines.push(`已彻底删除 ${d.name}（${d.removed.length} 处）`);
  lines.push(d.dryRun || d.status === 'blocked' ? '  将删除:' : '  已删除:');
  for (const s of d.plan.sources) lines.push(`    订阅源  ${s.source}  →  ${s.dir}`);
  for (const c of d.plan.targets) {
    lines.push(`    落点    ${SCOPE_MARK[c.scope] || c.scope}·${c.platform}  ${c.path}${c.linkType ? '（链接）' : '（实体副本）'}`);
  }
  if (!d.plan.sources.length && !d.plan.targets.length) lines.push('    （无）');
  if (d.status === 'blocked') lines.push('', '确认无误后加 --force 执行。');
  return lines.join('\n');
}

// 适配器总表：每个平台的两个落点都打绝对路径——「把 skill 变成 .claude / .workbuddy / .cursor」
// 在终端里直接可抄，不需要先起面板。
function renderAdapters(list) {
  const w = Math.max(...list.map((a) => a.id.length));
  return list
    .map((a) => {
      const tag = (a.enabled ? '[启用]' : '[   ]') + (a.isDefault ? ' [默认]' : '');
      return [
        `${a.id.padEnd(w)}  ${tag}  ${a.name}`,
        `  ${' '.repeat(w)}  项目  ${a.projectDir}`,
        `  ${' '.repeat(w)}  用户  ${a.userDir}`,
      ].join('\n');
    })
    .join('\n');
}

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
      summary: '平台适配器清单（每平台的项目级 / 用户级绝对落点）',
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
      flags: { project: { type: 'string' }, source: { type: 'string' }, long: { type: 'boolean' } },
      run: (ctx) => service.listAllSkills({ project: projectOf(ctx), source: ctx.source }),
      render: renderSkillList,
    },
    {
      id: 'skill.show',
      cli: [['skill', 'hub', 'show'], ['skill', 'show'], ['skill', 'describe']],
      http: ['GET', '/api/skills/detail'],
      summary: '查看单个 skill：完整描述 + 来源目录 + 各平台落点与当前形态',
      args: ['name'],
      flags: { project: { type: 'string' } },
      run: (ctx) => service.skillInfo({ name: ctx.name, project: projectOf(ctx) }),
      render: renderShow,
    },
    {
      // skill 的全文导出。注意与 bundled 的 `skill get` 分工：
      // get = 内置手册（repo-hub 之外的「本工具说明书」，三段拼接 + 顺手安装）；
      // cat = 任意 skill 的全文（给外部 agent 当业务上下文）。
      // 订阅源与**未入 Hub 的平台副本**都读得到 —— 后者从前只查订阅源，必然 NOT_FOUND。
      id: 'skill.cat',
      cli: [['skill', 'hub', 'cat'], ['skill', 'cat']],
      http: ['GET', '/api/skills/content'],
      summary: '输出 skill 全文（SKILL.md 或 --ref <相对路径>），订阅源与未入 Hub 的平台副本都能读',
      args: ['name'],
      flags: { ref: { type: 'string', hint: 'skill 内相对路径，如 references/api.md' }, project: { type: 'string' } },
      run: (ctx) => service.skillContent({ name: ctx.name, ref: ctx.ref, project: projectOf(ctx) }),
      // 三段拼接：引导语 → 正文 → 后续动作提示。--json 走纯数据，不打这些。
      render: (d) => {
        const bar = '─'.repeat(60);
        const where = d.source ? `来源: ${d.source}` : `落点: ${d.dir}`;
        return [
          `# skill: ${d.skillName}   ${where}`,
          bar,
          d.content.replace(/\s*$/, ''),
          bar,
          `# 需要迁移到本机？nx-rh skill hub migrate ${d.skillName} --to user`,
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
      // purge 是「这个名字不该存在了」——连各平台落点一起删。
      // **未入 Hub 的 skill 只有这一条路能删**（订阅源里根本没有它，remove 是 NOT_FOUND）。
      id: 'skill.purge',
      cli: [['skill', 'hub', 'purge'], ['skill', 'purge']],
      http: ['POST', '/api/skills/purge'],
      summary: '彻底删除 skill：所有平台落点 + 订阅源里的实文件（--dry-run 先看清单）',
      args: ['name'],
      flags: {
        force: { type: 'boolean', hint: '落点里有实体副本时必须加（可能含本地改动）' },
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
      summary: '平台副本 → 订阅源（<name...> | --all 取「未入 Hub」那批；提交后删除目标实文件）',
      args: [{ name: 'name', rest: true, required: false }],
      flags: {
        // 缺省 all（而不是全局的 project）：未入 Hub 的 skill 常常落在**用户级**平台目录里，
        // 只扫项目级会直接报「目标目录里没有该 skill」——`skill submit --all` 正是主推用法。
        to: { ...TO, default: 'all' },
        platform: { type: 'string' },
        project: { type: 'string' },
        force: { type: 'boolean' },
        keepTarget: { type: 'boolean' },
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
