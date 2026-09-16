// 设置模块：通用设置项，以及中心仓库 / 项目目录的候选管理。
import * as service from './service.js';
import { badInput } from '../../core/errors.js';

// `setting set` 的两端归一：
//   CLI  nx-rh setting set skillSyncMode=copy platforms=a,b
//   CLI  nx-rh setting set skillSyncMode copy      （历史写法，value 仍可含 '=' 或空格）
//   HTTP POST /api/settings  { skillSyncMode: 'copy', ... }   （body 本身就是 patch）
const SET_USAGE = 'nx-rh setting set <key> <value> 或 nx-rh setting set k1=v1 [k2=v2 ...]';

function patchFrom(ctx, meta) {
  if (meta.transport === 'http') {
    const { pairs: _pairs, ...rest } = ctx; // pairs 只属于 CLI 形态，这里只用于剔除
    return rest;
  }

  const pairs = ctx.pairs || [];
  if (!pairs.length) throw badInput(`用法: ${SET_USAGE} —— 缺少参数`);

  // 以「第一个 token 是否含 =」区分两种语法，而不是靠 token 个数——
  // 否则 `setting set note a=b`（旧写法的 value 恰好含 =）和
  // `setting set platforms a b`（值含空格）都会被误判成新语法而报错。
  if (!pairs[0].includes('=')) {
    if (pairs.length < 2) throw badInput(`用法: ${SET_USAGE} —— 缺少参数 <value>`);
    return { [pairs[0]]: pairs.slice(1).join(' ') };
  }

  const patch = {};
  for (const p of pairs) {
    const eq = p.indexOf('=');
    if (eq <= 0) throw badInput(`用法: ${SET_USAGE} —— 参数格式应为 key=value，收到: ${p}`);
    patch[p.slice(0, eq)] = p.slice(eq + 1);
  }
  return patch;
}

const renderSettings = (d) =>
  Object.entries(d).map(([k, v]) => `${k} = ${Array.isArray(v) ? v.join(',') : v}`).join('\n');

const renderCandidates = (list, emptyHint) =>
  list.length ? list.map((p) => `${p}`).join('\n') : emptyHint;

export default {
  id: 'settings',
  title: '设置（= Web「设置」页）',
  order: 40,
  view: () => import('./view.jsx'),

  actions: [
    {
      id: 'setting.get',
      cli: ['setting', 'get'],
      http: null, // 设置由 /api/bootstrap 一并下发，无需单独路由
      summary: '读取设置（可跟单个键名）',
      args: [{ name: 'key', required: false }],
      run: async (ctx) => {
        const s = await service.getSettings();
        return ctx.key ? s[ctx.key] : s;
      },
      render: (d, ctx) =>
        ctx.key ? String(d) : renderSettings(d),
    },
    {
      id: 'setting.set',
      cli: ['setting', 'set'],
      http: ['POST', '/api/settings'],
      summary: '写入设置，支持一次多个（key=value）',
      args: [{ name: 'pairs', rest: true, required: false }],
      run: (ctx, meta) => service.updateSettings(patchFrom(ctx, meta)),
      render: renderSettings,
    },

    // ---- 中心仓库候选：`skill central ...` ----
    {
      id: 'skill.central.list',
      cli: ['skill', 'central', 'list'],
      http: null,
      summary: '中心仓库候选清单（* 为当前项）',
      // --json 保持历史形状（纯字符串数组）。「当前项」的标注只在文本模式出现，
      // 因此 render 需要是 async——自己去读一次设置，而不是让 run 换一个数据形状。
      run: () => service.listCandidates('central'),
      render: async (list) => {
        if (!list.length) return '（暂无中心仓库候选，用 skill central add <path> 添加）';
        const { skillCentralPath } = await service.getSettings();
        return list.map((p) => `${p === skillCentralPath ? '*' : ' '} ${p}`).join('\n');
      },
    },
    {
      id: 'skill.central.add',
      cli: ['skill', 'central', 'add'],
      http: ['POST', '/api/skills/central'],
      summary: '添加中心仓库候选并设为当前',
      args: ['path'],
      run: async (ctx) => {
        const list = await service.addCandidate('central', ctx.path);
        await service.setCentralPath(ctx.path);
        return { path: list[list.length - 1], candidates: list };
      },
      render: (d) => `已添加中心仓库: ${d.path}`,
    },
    {
      id: 'skill.central.remove',
      cli: ['skill', 'central', 'remove'],
      http: ['DELETE', '/api/skills/central'],
      summary: '从候选移除中心仓库（不动磁盘）',
      args: ['path'],
      run: (ctx) => service.removeCandidate('central', ctx.path),
      render: (l) => `已移除，剩余 ${l.length} 个候选`,
    },
    {
      id: 'skill.central',
      cli: ['skill', 'central'],
      http: null,
      summary: '查看 / 设置当前中心仓库路径',
      args: [{ name: 'path', required: false }],
      // 不带参数时 --json 返回裸字符串（历史契约）；带参数时返回设置对象
      run: async (ctx) => {
        if (ctx.path) return service.setCentralPath(ctx.path);
        const s = await service.getSettings();
        return s.skillCentralPath || '（未设置）';
      },
      render: (d, ctx) => (ctx.path ? `中心仓库已设置: ${d.skillCentralPath}` : String(d)),
    },

    // ---- 项目目录候选：`skill project ...` ----
    {
      id: 'skill.project.list',
      // 裸 `skill project` 与 `skill project list` 同义（延续历史行为）
      cli: [['skill', 'project', 'list'], ['skill', 'project']],
      http: null,
      summary: '项目目录候选清单',
      run: () => service.listCandidates('project'),
      render: (l) => renderCandidates(l, '（暂无项目目录候选，用 skill project add <path> 添加）'),
    },
    {
      id: 'skill.project.add',
      cli: ['skill', 'project', 'add'],
      http: ['POST', '/api/skills/project'],
      summary: '添加项目目录候选',
      args: ['path'],
      run: (ctx) => service.addCandidate('project', ctx.path),
      render: (l, ctx) => `已添加项目目录（共 ${l.length} 个）: ${l[l.length - 1] ?? ctx.path}`,
    },
    {
      id: 'skill.project.remove',
      cli: ['skill', 'project', 'remove'],
      http: ['DELETE', '/api/skills/project'],
      summary: '从候选移除项目目录（不动磁盘）',
      args: ['path'],
      run: (ctx) => service.removeCandidate('project', ctx.path),
      render: (l) => `已移除，剩余 ${l.length} 个`,
    },

    // ---- 平台范围 ----
    {
      id: 'setting.platforms',
      cli: ['skill', 'platform'],
      http: null,
      summary: '查看 / 设置默认支持的平台范围（首个为默认平台）',
      args: [{ name: 'platforms', rest: true, required: false }],
      run: async (ctx) => {
        if (ctx.platforms.length) {
          return service.updateSettings({ platforms: ctx.platforms, defaultPlatform: ctx.platforms[0] });
        }
        // 只回这两个键——历史 --json 形状是 {platforms, defaultPlatform}，
        // 返回整个 settings 虽是其超集，却会让做严格断言的老消费方炸掉
        const s = await service.getSettings();
        return { platforms: s.platforms, defaultPlatform: s.defaultPlatform };
      },
      render: (d) => `平台: ${d.platforms.join(', ')}\n默认: ${d.defaultPlatform}`,
    },
  ],
};
