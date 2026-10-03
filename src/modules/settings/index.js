// 设置模块：通用设置项的读写。
// 订阅源（skill hub）/ 项目目录 / 平台范围这些与 skill 域强相关的命令，
// 已统一收归 skills 模块（见 ../skills/index.js），设置模块只保留通用键值。
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
      render: (d, ctx) => (ctx.key ? String(d) : renderSettings(d)),
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
  ],
};
