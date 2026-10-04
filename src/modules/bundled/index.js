// 内置 skill 包模块：把随包发布的 skill 说明装到用户的 skills 目录。
// 没有面板视图——安装入口在 Skill 页，列出/安装都通过 action 暴露。
//
// 多 skill（见脚手架 B04）：`assets/` 下可以有多个 skill，由 `assets/groups.json`
// 归组；`skill install --group <key>` 一键装一组。groups.json 只是**便捷别名表**，
// 缺失/损坏时降级为「每个 assets/<x> 各成一组」——事实源永远只有 `assets/<x>/SKILL.md`。
import * as service from './service.js';
import { badInput } from '../../core/errors.js';

// <name> 与 --group 互斥：二者语义等价，报错比替用户猜意图友好（B04 §CLI 形状）
function exclusive(ctx, cmd) {
  if (ctx.group !== undefined && ctx.group !== null && ctx.group !== '' && ctx.name) {
    throw badInput(`${cmd} 的 <name> 与 --group 只能给一个`);
  }
}

const GROUP_FLAG = { type: 'string', hint: 'groups.json 里的组名（与 <name> 互斥）' };

// `skill list` 的人读渲染（B04 §skill list 的输出）
function renderList(d) {
  const def = d.defaultGroup ? (d.groupSkills[d.defaultGroup] || []) : [];
  const w = Math.max(0, ...d.skills.map((s) => s.length));
  const lines = ['可装的 skill:'];
  for (const s of d.skills) {
    lines.push(def.includes(s) ? `  * ${s.padEnd(w)}  （默认 install）` : `  * ${s}`);
  }
  lines.push('可装的 group:');
  for (const g of d.groups) {
    lines.push(d.summaries[g] ? `  * ${g.padEnd(w)}  ${d.summaries[g]}` : `  * ${g}`);
  }
  if (d.source === 'assets-dirs') {
    lines.push('', '（assets/groups.json 缺失或损坏，已降级为目录扫描：每个内置 skill 各成一组）');
  }
  return lines.join('\n');
}

// get 的三段拼接（顺序固定）：prefix 在最前告诉 agent 文件位置与「复制到自己可访问路径」；
// sentinel 让 agent 知道正文从哪行开始，不把引导语一起带进下游上下文。
// --json 不走这里（机器协议，不含 prefix）。
function renderContent(d) {
  const i = d.install;
  const inst = i.status === 'conflict'
    ? `冲突: ${i.path}（${i.count} 个文件不同）—— 需要覆盖时用 nx-rh skill install --force`
    : i.skipped
      ? `已是最新: ${i.path}（无差异）`
      : i.replaced
        ? `已替换: ${i.path}`
        : `已安装: ${i.path}`;
  return [
    `# === ${d.skillName} skill context ===`,
    `# 以下内容来自 nx-rh skill \`${d.skillName}\` 的 ${d.ref}。`,
    '# 建议：把 sentinel 之后的正文完整复制到你自己可访问的路径，再按其内容操作。',
    '# --- begin skill content (do not modify this line) ---',
    '',
    d.content.replace(/\s*$/, ''),
    '',
    '-- install 状态 --',
    inst,
  ].join('\n');
}

export default {
  id: 'bundled',
  title: '内置 skill 包',
  order: 50,
  view: null,

  actions: [
    {
      id: 'bundled.list',
      // `skill list` 是 B04 的强制命令面（列出**包内**可装的 skill，与「订阅源里的
      // skill 清单」是两件事——后者现在叫 `skill hub list`）。
      // 后两条是历史别名：`skill install --list` 早于 `bundled list` 存在，
      // 命令路径里带 flag，因此匹配是按 token 前缀而非「非 flag 前缀」。
      cli: [['skill', 'list'], ['skill', 'install', '--list'], ['bundled', 'list']],
      http: ['GET', '/api/bundled'],
      summary: '列出包内自带 skill（含文件数与描述）+ 默认装哪个 + 有哪些 group',
      // 两端返回结构刻意不同：HTTP 供面板顺带拿到默认安装目录与每个 skill 的文件数；
      // CLI 的 --json 走 B04 的形状（skills 是**名字数组** + defaultGroup/groups/source）。
      run: async (_ctx, meta) => {
        const info = await service.groupsInfo();
        if (meta.transport !== 'http') return info;
        const details = await service.listBundledSkills();
        // 展开顺序要紧：info.skills 是**名字数组**，details 是**对象数组**
        // （{name,dir,files,description}）。先铺 info、再压 details，否则
        // skills 会被覆盖回字符串数组 —— 面板与 smoke 读 skills[].name 全变 undefined。
        return {
          ...info,
          defaultDir: service.DEFAULT_SKILLS_DIR,
          // smoke 与面板都在读 skills[].name —— HTTP 侧保持这个形状
          skills: details,
          details,
        };
      },
      render: renderList,
    },
    {
      id: 'bundled.groups',
      cli: [['skill', 'groups'], ['bundled', 'groups']],
      http: ['GET', '/api/bundled/groups'],
      summary: '列出可装的 group（groups.json 的组名 → 它包含哪些 skill）',
      run: () => service.groupsInfo(),
      render: (d) => {
        const head = `可装的 group（来源: ${d.source}${d.defaultGroup ? ` · 默认组: ${d.defaultGroup}` : ''}）:`;
        const lines = [head];
        for (const g of d.groups) {
          lines.push(`  ${g}${d.summaries[g] ? '  —— ' + d.summaries[g] : ''}`);
          lines.push(`      skills: ${(d.groupSkills[g] || []).join(', ')}`);
        }
        if (!d.groups.length) lines.push('  （无）');
        return lines.join('\n');
      },
    },
    {
      id: 'bundled.install',
      cli: ['skill', 'install'],
      http: ['POST', '/api/bundled/install'],
      summary: '安装内置 skill 到 skills 目录（默认 nx-rh → ~/.claude/skills；--group <key> 一键装一组）',
      args: [{ name: 'name', required: false }],
      flags: { group: GROUP_FLAG, to: { type: 'string' }, force: { type: 'boolean' } },
      run: (ctx) => {
        exclusive(ctx, 'skill install');
        return service.installBundledSkill({
          name: ctx.name || service.DEFAULT_SKILL_NAME,
          group: ctx.group,
          to: ctx.to,
          force: ctx.force,
        });
      },
      render: (d) => {
        // 聚合形状用**显式 group 字段**判别，不做形状嗅探（B04 §实现要点）
        if (d.group) {
          const done = d.skills.filter((r) => r.status === 'ok').length;
          const lines = [`group ${d.group}: ${done}/${d.skills.length} 已就绪`];
          for (const r of d.skills) {
            const what = r.status === 'conflict'
              ? `冲突（${r.count} 个文件不同）→ 用 --force 覆盖`
              : r.skipped ? '已是最新'
                : `${r.replaced ? '已更新' : '已安装'}（${r.files} 个文件）-> ${r.path}`;
            lines.push(`  ${r.name.padEnd(16)} ${what}`);
          }
          return lines.join('\n');
        }
        if (d.status === 'conflict') {
          const files = d.files.map((f) => `  ${f.file}  ${f.side}`).join('\n');
          return `目标已存在且内容不同（${d.count} 个文件）: ${d.path}\n${files}\n用 --force 覆盖，或先删除目标目录`;
        }
        if (d.skipped) return `已是最新，无需安装: ${d.path}`;
        return `${d.replaced ? '已更新' : '已安装'} ${d.name}（${d.files} 个文件）-> ${d.path}`;
      },
    },
    {
      // A03 §一/§三：get 与 install 是互补能力——install 让本机 agent 学得会用，
      // get 让**不读 ~/.claude/skills 的外部 agent**一键拿全上下文。缺一即单边能力打折。
      id: 'bundled.get',
      cli: ['skill', 'get'],
      http: ['GET', '/api/bundled/content'],
      summary: '输出内置 skill 全文（prefix + sentinel + 正文 + install 状态），并顺手装到本机',
      args: [{ name: 'name', required: false }, { name: 'ref', required: false }],
      flags: { group: GROUP_FLAG, to: { type: 'string' } },
      run: (ctx) => {
        exclusive(ctx, 'skill get');
        return service.bundledSkillContent({ name: ctx.name, group: ctx.group, ref: ctx.ref, to: ctx.to });
      },
      render: (d) => (d.group
        ? d.skills.map(renderContent).join('\n\n' + '─'.repeat(60) + '\n\n')
        : renderContent(d)),
    },
  ],
};
