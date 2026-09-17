// 环境变量模块：查看与编辑 Windows 注册表里的持久化变量（用户级 / 系统级）。
//
// 本模块刻意**不声明 `resource`**。CRUD 完备性检查要求的 add / update 二分对这里是伪需求：
// 环境变量是 upsert 语义（同 setx），调用方不该先查存在性再决定敲 `add` 还是 `update`。
// 硬凑成 CRUD 只会让 CLI 多一条没有意义的命令。
//
// 安全网（自动快照 + --dry-run）在 service 层，不在 action 里——这样它是每条写路径的
// 必经之路，而不是每个 action 各自记得调。详见 ../env/service.js 的 guardedWrite。
import * as service from './service.js';
import { badInput } from '../../core/errors.js';

// CLI 侧的 kind 用短词（--kind expand 比 --kind ExpandString 好敲），
// 注册表侧用真名。映射只在这里出现一次。
const KIND_IN = { string: 'String', expand: 'ExpandString' };
const KIND_OUT = { String: 'string', ExpandString: 'expand' };

const SCOPE_FLAG = {
  scope: { type: 'string', enum: ['user', 'system'], default: 'user', hint: 'user|system' },
};
// 读命令用的 scope：**不能带 default**。带了 default 就意味着 `applySpec` 总会塞一个值进来，
// 于是 env list 永远走单 scope 分支、合并视图（遮蔽分析 + 生效 PATH）永远出不来。
const OPT_SCOPE_FLAG = {
  scope: { type: 'string', enum: ['user', 'system'], hint: 'user|system（省略则合并两个 scope）' },
};
const DRY_FLAG = { 'dry-run': { type: 'boolean', hint: '只显示将要发生的改动，不落盘' } };
const NOTIFY_FLAG = { 'no-notify': { type: 'boolean', hint: '跳过 WM_SETTINGCHANGE 广播（约省 3 秒）' } };

const notifyOf = (ctx) => !ctx['no-notify'];

function kindIn(kind) {
  if (!kind) return undefined;
  const k = KIND_IN[String(kind).toLowerCase()];
  if (!k) throw badInput(`--kind 只能是 ${Object.keys(KIND_IN).join(' | ')}，收到: ${kind}`);
  return k;
}

// ─── 渲染 ─────────────────────────────────────────────────────────────

const truncate = (v, n = 64) => (v.length > n ? v.slice(0, n - 1) + '…' : v);

function renderStatus(s) {
  if (!s.supported) {
    return `平台: ${s.platform}\n环境变量模块目前只支持 Windows。${s.reason ? '\n' + s.reason : ''}`;
  }
  const lines = [
    `平台:   ${s.platform}`,
    `提权:   ${s.elevated ? '是' : '否'}${s.elevated ? '' : ' —— 系统级只可读（以管理员身份运行 nx-rh 后可写）'}`,
    `用户级: ${s.scopeWritable.user ? '可写' : '不可写'}`,
    `系统级: ${s.scopeWritable.system ? '可写' : '只读（需管理员）'}`,
    `快照:   ${s.snapshotDir}`,
    '',
    s.note,
  ];
  return lines.join('\n');
}

function renderMerged(merged) {
  if (!merged.length) return '（没有任何环境变量）';
  const w = Math.max(...merged.map((m) => m.name.length));
  const rows = merged.map((m) => {
    const mark = m.shadow ? ' *' : m.concat ? ' +' : m.duplicate ? ' =' : '  ';
    const src = m.scope === 'user' ? 'user' : 'sys ';
    const v = m.user || m.system;
    return `  ${m.name.padEnd(w)}  ${src}${mark} ${(KIND_OUT[v.kind] || v.kind).padEnd(6)} ${truncate(v.value)}`;
  });
  return [
    `用户级 / 系统级变量（共 ${merged.length} 条）`,
    '  标记: * 用户级遮蔽了系统级（两边值不同）',
    '        + PATH 为拼接（系统在前、用户在后），不是遮蔽',
    '        = 两边都有且值相同',
    '',
    ...rows,
  ].join('\n');
}

function renderScoped(d) {
  if (!d.values.length) return `（${d.scope} 级没有任何环境变量）`;
  const w = Math.max(...d.values.map((v) => v.name.length));
  return d.values
    .map((v) => `  ${v.name.padEnd(w)}  ${(KIND_OUT[v.kind] || v.kind).padEnd(6)} ${truncate(v.value)}`)
    .join('\n');
}

function renderList(d) {
  if (d.scope) return renderScoped(d);
  const parts = [renderMerged(d.merged)];
  if (d.path && d.path.length) {
    parts.push(
      '',
      `生效 PATH（系统 ${d.path.filter((p) => p.scope === 'system').length} 条 + 用户 ${d.path.filter((p) => p.scope === 'user').length} 条，按此顺序）:`,
      ...d.path.map((p, i) => `  ${String(i).padStart(3)}. [${p.scope === 'user' ? 'user' : 'sys '}] ${p.path}${p.duplicate ? '   (重复)' : ''}`)
    );
  }
  return parts.join('\n');
}

function renderGet(d) {
  if (d.pathEntries) {
    return [
      `Path` + (d.user ? ' （用户级）' : ' （系统级）'),
      '',
      `生效 PATH 由系统级与用户级**拼接**而成，不是覆盖 —— 共 ${d.pathEntries.length} 条:`,
      ...d.pathEntries.map((p, i) => `  ${String(i).padStart(3)}. [${p.scope === 'user' ? 'user' : 'sys '}] ${p.path}${p.duplicate ? '   (重复)' : ''}`),
    ].join('\n');
  }
  const lines = [d.name];
  if (d.user) lines.push(`  用户级: [${KIND_OUT[d.user.kind] || d.user.kind}] ${d.user.value}`);
  if (d.system) lines.push(`  系统级: [${KIND_OUT[d.system.kind] || d.system.kind}] ${d.system.value}`);
  if (d.shadow) lines.push('  ⚠ 用户级遮蔽了系统级 —— 新进程看到的是用户级的值');
  return lines.join('\n');
}

function renderPathList(d) {
  const section = (scope, entries) => {
    if (!entries.length) return [`${scope} 级 PATH: （空）`];
    return [
      `${scope} 级 PATH（${entries.length} 条）:`,
      ...entries.map((e, i) => `  ${String(i).padStart(3)}. ${e}`),
    ];
  };
  if (d.scope) return section(d.scope, d.entries).join('\n');
  return [
    ...section('用户', d.user),
    '',
    ...section('系统', d.system),
    '',
    '生效顺序 = 系统级条目在前，用户级条目在后。',
  ].join('\n');
}

function renderWrite(d) {
  if (d.status === 'skipped') return `已跳过：${d.reason}`;
  const head = d.dryRun
    ? `[dry-run] ${d.reason} —— 以下改动**未**落盘`
    : `${d.reason} —— 已写入（写入前快照: ${d.snapshot}）`;
  const lines = [head, ''];
  if (!d.changed && d.dryRun) lines.push('（没有实际变化）');
  lines.push(d.diff);
  if (!d.dryRun) {
    lines.push('', '已广播 WM_SETTINGCHANGE：新开的终端会读到新值；已启动的进程不会。');
  }
  return lines.join('\n');
}

function renderSnapshotList(list) {
  if (!list.length) return '（还没有快照。每次写操作前都会自动生成一份）';
  return list
    .map((s) => `${s.id}  ${s.createdAt}  user:${s.userCount} sys:${s.systemCount}  ${s.reason}`)
    .join('\n');
}

// ─── action 表 ────────────────────────────────────────────────────────

export default {
  id: 'env',
  title: '环境变量',
  // 与「设置」相邻：两者都是本机配置而非仓库内容
  order: 45,
  view: () => import('./view.jsx'),

  actions: [
    {
      id: 'env.status',
      cli: ['env', 'status'],
      http: ['GET', '/api/env/status'],
      summary: '能力探测：平台 / 驱动 / 是否提权 / 系统级可否写',
      run: () => service.status(),
      render: renderStatus,
    },
    {
      id: 'env.list',
      cli: ['env', 'list'],
      http: ['GET', '/api/env'],
      summary: '列出变量（不带 --scope 时合并两scope并标注遮蔽）',
      flags: { ...OPT_SCOPE_FLAG },
      run: (ctx) => service.list({ scope: ctx.scope }),
      render: renderList,
    },
    {
      id: 'env.get',
      cli: ['env', 'get'],
      http: ['GET', '/api/env/:name'],
      summary: '查看单个变量（两个 scope 的值 + 遮蔽判断）',
      args: ['name'],
      run: (ctx) => service.get(ctx.name),
      render: renderGet,
    },
    {
      id: 'env.set',
      cli: ['env', 'set'],
      http: ['PUT', '/api/env/:name'],
      summary: '写入变量（upsert；已存在的变量保留其原始大小写与类型）',
      // value 同时是位置参数与 --value flag：--value= 是「值以 -- 开头」的逃生口
      // （如 JAVA_OPTS 这类存命令行参数的变量），否则会被参数解析器当成未知 flag 拒掉。
      // runCli 是 {...positionals, ...flags}，flag 胜出，所以二者共用同一个名字。
      args: [{ name: 'name' }, { name: 'value', required: false }],
      flags: {
        value: { type: 'string', hint: '值（值以 -- 开头时用这个）' },
        ...SCOPE_FLAG,
        kind: { type: 'string', enum: Object.keys(KIND_IN), hint: 'string|expand' },
        ...DRY_FLAG,
        ...NOTIFY_FLAG,
      },
      run: (ctx) => {
        if (ctx.value === undefined || ctx.value === '') {
          throw badInput('缺少值：nx-rh env set <name> <value>（或 --value=<value>）');
        }
        return service.setVariable({
          name: ctx.name,
          value: ctx.value,
          scope: ctx.scope,
          kind: kindIn(ctx.kind),
          dryRun: ctx['dry-run'],
          notify: notifyOf(ctx),
        });
      },
      render: renderWrite,
    },
    {
      id: 'env.remove',
      cli: ['env', 'remove'],
      http: ['DELETE', '/api/env/:name'],
      summary: '删除变量（不存在时幂等跳过，不算错误）',
      args: ['name'],
      flags: { ...SCOPE_FLAG, ...DRY_FLAG, ...NOTIFY_FLAG },
      run: (ctx) =>
        service.removeVariable({
          name: ctx.name,
          scope: ctx.scope,
          dryRun: ctx['dry-run'],
          notify: notifyOf(ctx),
        }),
      render: renderWrite,
    },

    // ---- PATH：按条目增删，不让调用方手拼几千字符的字符串 ----
    {
      id: 'env.path.list',
      cli: ['env', 'path', 'list'],
      http: ['GET', '/api/env/path'],
      summary: '按条目列出 PATH（不手拼字符串）',
      flags: { ...OPT_SCOPE_FLAG },
      run: (ctx) => service.pathList({ scope: ctx.scope }),
      render: renderPathList,
    },
    {
      id: 'env.path.add',
      cli: ['env', 'path', 'add'],
      http: ['POST', '/api/env/path'],
      summary: '把一个目录加进 PATH（默认追加在末尾，--first 前置）',
      args: ['dir'],
      flags: {
        ...SCOPE_FLAG,
        first: { type: 'boolean', hint: '前置而不是追加（会遮蔽系统同名工具，慎用）' },
        ...DRY_FLAG,
        ...NOTIFY_FLAG,
      },
      run: (ctx) =>
        service.pathAdd({
          dir: ctx.dir,
          scope: ctx.scope,
          position: ctx.first ? 'first' : 'last',
          dryRun: ctx['dry-run'],
          notify: notifyOf(ctx),
        }),
      render: renderWrite,
    },
    {
      id: 'env.path.remove',
      cli: ['env', 'path', 'remove'],
      http: ['DELETE', '/api/env/path'],
      summary: '从 PATH 移除一个目录（不存在时幂等跳过；不会让 PATH 变空）',
      args: ['dir'],
      flags: { ...SCOPE_FLAG, ...DRY_FLAG, ...NOTIFY_FLAG },
      run: (ctx) =>
        service.pathRemove({
          dir: ctx.dir,
          scope: ctx.scope,
          dryRun: ctx['dry-run'],
          notify: notifyOf(ctx),
        }),
      render: renderWrite,
    },

    // ---- 快照：写操作前的自动备份，也可手动打点 ----
    {
      id: 'env.snapshot.list',
      cli: ['env', 'snapshot', 'list'],
      http: ['GET', '/api/env/snapshots'],
      summary: '列出快照（每次写操作前自动生成）',
      run: () => service.listSnapshots(),
      render: renderSnapshotList,
    },
    {
      id: 'env.snapshot.save',
      cli: ['env', 'snapshot', 'save'],
      http: ['POST', '/api/env/snapshots'],
      summary: '手动存一份快照（比如准备在别处改注册表之前）',
      args: [{ name: 'label', required: false }],
      run: (ctx) => service.saveSnapshot(ctx.label),
      render: (s) => `已保存快照: ${s.id}\n  user ${s.user.values.length} 条 / system ${s.system.values.length} 条`,
    },
    {
      id: 'env.snapshot.restore',
      cli: ['env', 'snapshot', 'restore'],
      http: ['POST', '/api/env/snapshots/:id/restore'],
      summary: '恢复快照（恢复前会自动再存一份，所以恢复本身可被恢复）',
      args: ['id'],
      flags: { ...DRY_FLAG, ...NOTIFY_FLAG },
      run: (ctx) =>
        service.restoreSnapshot({
          id: ctx.id,
          dryRun: ctx['dry-run'],
          notify: notifyOf(ctx),
        }),
      render: (d) => {
        const head = d.dryRun
          ? `[dry-run] 恢复快照 ${d.id} —— 以下改动**未**落盘`
          : `恢复快照 ${d.id} 完成（恢复前快照: ${d.snapshot}）`;
        const lines = [head];
        if (d.skippedScopes?.length) {
          lines.push(
            '',
            `⚠ 未恢复的 scope: ${d.skippedScopes.join(', ')} ——` +
              ' 系统级恢复需要以管理员身份运行 nx-rh，用户级已恢复。'
          );
        }
        lines.push('', d.diff);
        return lines.join('\n');
      },
    },
  ],
};
