// 系统模块：只做聚合与自检，没有自己的业务状态，也没有面板视图。
//
// 分层例外：本模块是**刻意的聚合器**，允许 import 其他模块的 service。
// 其余模块之间禁止互相依赖（唯一的只读例外是 settings，见其 service 注释）。
import { readFileSync } from 'node:fs';
import { storePathFromEnv } from '../../core/paths.js';
import { compileRoute } from '../../runtime/spec.js';
import { badInput, notFound } from '../../core/errors.js';
import * as settings from '../settings/service.js';
import * as repos from '../repos/service.js';
import { listAdapters } from '../skills/adapters.js';

const VERSION = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')
).version;

// 命令表：CLI 命令 ↔ HTTP 路由的对照，bootstrap 与 routes 共用同一份，
// 也与 `nx-rh help --json` 覆盖同一批命令（含 serve/help/version 这样的平台命令）。
//
// 动态 import：runtime/registry 静态依赖本模块，静态引入会形成循环。
// 该函数只在启动完成后被调用，届时 cli.js 早已求值完毕。
async function commandTable() {
  const { ALL_COMMANDS, commandEntry } = await import('../../runtime/cli.js');
  return ALL_COMMANDS.map(commandEntry);
}

// 一次拿齐面板启动所需的全部上下文。
// 历史缺口：Web 有 /api/bootstrap，CLI 却没有对应命令，agent 只能多次往返拼装。
async function bootstrap() {
  return {
    version: VERSION,
    storePath: storePathFromEnv(),
    settings: await settings.getSettings(),
    adapters: listAdapters(),
    repos: await repos.listRepos(),
    // 命令表随 bootstrap 下发前端，面板底部的「CLI 等价」提示由此渲染，
    // 而不是各视图手写字符串。带 http 字段，故映射是双向可查的。
    commands: await commandTable(),
  };
}

// 把 `POST /api/x` 或 `/api/x` 解析成 { method|null, path }
function parseHttpQuery(input) {
  const s = String(input || '').trim();
  const m = /^([A-Za-z]+)\s+(.*)$/.exec(s);
  const method = m ? m[1].toUpperCase() : null;
  const path = (m ? m[2] : s).split('?')[0];
  if (!path.startsWith('/')) {
    throw badInput(`HTTP 查询需形如 "/api/repos" 或 "POST /api/repos"，收到: ${input}`);
  }
  return { method, path };
}

// 反向查找：手里有一个端点，想知道该敲哪条命令。
// 复用 compileRoute 编译出的正则，所以 `/api/repos/:id` 这类带参路由
// 能匹配到具体实例（如 DELETE /api/repos/r_abc）。
async function lookupByHttp(input) {
  const { method, path } = parseHttpQuery(input);
  const table = await commandTable();
  const hit = table.filter((c) => {
    if (!c.http) return false;
    if (method && c.http.method !== method) return false;
    return compileRoute({ http: [c.http.method, c.http.path] }).regex.test(path);
  });
  if (!hit.length) throw notFound(`没有路由匹配: ${input}（用 nx-rh routes 查看全部对照）`);
  return hit;
}

export default {
  id: 'system',
  title: '系统',
  order: 0,
  view: null,

  actions: [
    {
      id: 'system.bootstrap',
      cli: ['bootstrap'],
      http: ['GET', '/api/bootstrap'],
      summary: '聚合上下文：版本 / 存储路径 / 设置 / 适配器 / 仓库',
      run: bootstrap,
    },
    {
      id: 'system.health',
      cli: ['health'],
      http: ['GET', '/api/health'],
      summary: '健康检查（进程存活 + 存储可达）',
      run: async () => {
        const s = await settings.getSettings();
        return {
          status: 'ok',
          version: VERSION,
          storePath: storePathFromEnv(),
          storeReadable: !!s,
        };
      },
    },
    {
      id: 'system.routes',
      cli: ['routes'],
      // 纯 CLI 的自省命令：面板已通过 bootstrap 拿到同一份命令表，无需再开路由
      http: null,
      summary: '命令 ↔ 路由对照表（--module 过滤；--http 反查命令）',
      flags: {
        module: { type: 'string', hint: '模块名' },
        http: { type: 'string', hint: 'METHOD /api/path' },
      },
      run: async (ctx) => {
        // 反向：手里有端点，查该敲哪条命令
        if (ctx.http) return lookupByHttp(ctx.http);

        const table = await commandTable();
        if (!ctx.module) return table;

        const known = [...new Set(table.map((c) => c.module))];
        if (!known.includes(ctx.module)) {
          throw badInput(`未知模块: ${ctx.module}（可用: ${known.join(', ')}）`);
        }
        return table.filter((c) => c.module === ctx.module);
      },
      render: (list) => {
        if (!list.length) return '（无匹配）';
        const w = Math.max(...list.map((c) => c.command.length));
        return list
          .map((c) => `${c.command.padEnd(w + 2)}${c.http ? `${c.http.method} ${c.http.path}` : '（仅 CLI，无 HTTP 路由）'}`)
          .join('\n');
      },
    },
  ],
};
