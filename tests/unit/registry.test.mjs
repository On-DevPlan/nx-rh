// 一致性测试：把「Web 上每个操作都有等价 CLI 命令」从口头约定变成可执行断言。
//
// 需要对齐的三张表：
//   1. src/modules/*/               文件系统上的功能域目录
//   2. src/runtime/registry.js      后端注册表 → 决定 CLI 命令与 HTTP 路由
//   3. src/web/frontend/registry.js 前端视图注册表 → 决定 tab 与面板
//
// 改造前这三者靠人肉维护：CLI 手写 switch + help 字符串，路由表另写一份，
// 视图注册表再写一份。任何一处漏改都不会被发现——直到用户点到一个没有 CLI 的按钮。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODULES_DIR = join(ROOT, 'src', 'modules');

const { MODULES, ACTIONS } = await import(
  pathToFileURL(join(ROOT, 'src', 'runtime', 'registry.js')).href
);
const { cliPathsOf, usageOf } = await import(
  pathToFileURL(join(ROOT, 'src', 'runtime', 'spec.js')).href
);

const moduleDirs = readdirSync(MODULES_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .filter((name) => {
    try {
      readFileSync(join(MODULES_DIR, name, 'index.js'));
      return true;
    } catch {
      return false;
    }
  });

const frontendRegistrySrc = readFileSync(join(ROOT, 'src', 'web', 'frontend', 'registry.js'), 'utf8');
const frontendViewIds = [...frontendRegistrySrc.matchAll(/\{\s*id:\s*'([^']+)'/g)].map((m) => m[1]);

test('每个模块目录都在后端注册表登记了', () => {
  const registered = new Set(MODULES.map((m) => m.id));
  const missing = moduleDirs.filter((d) => !registered.has(d));
  assert.deepEqual(missing, [], `这些模块目录没有在 src/runtime/registry.js 里登记: ${missing}`);
});

test('注册表里的模块都有对应目录', () => {
  const ghost = MODULES.map((m) => m.id).filter((id) => !moduleDirs.includes(id));
  assert.deepEqual(ghost, [], `注册表引用了不存在的模块目录: ${ghost}`);
});

test('每条 action 都声明了 CLI 命令（Web 操作必须有 CLI 等价）', () => {
  for (const a of ACTIONS) {
    const paths = cliPathsOf(a);
    assert.ok(paths.length > 0, `action ${a.id} 没有声明 cli`);
    for (const p of paths) {
      assert.ok(p.length > 0, `action ${a.id} 的 cli 路径为空`);
      assert.ok(
        p.every((seg) => typeof seg === 'string' && seg.length),
        `action ${a.id} 的 cli 路径含有非法片段`
      );
    }
  }
});

test('action id 与 CLI 路径均不重复', () => {
  const ids = ACTIONS.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length, '存在重复的 action id');

  const cliKeys = ACTIONS.flatMap((a) => cliPathsOf(a).map((p) => p.join(' ')));
  const dup = cliKeys.filter((k, i) => cliKeys.indexOf(k) !== i);
  assert.deepEqual(dup, [], `存在重复的 CLI 命令路径: ${dup}`);
});

test('action 的 http 要么是路由数组，要么显式 null', () => {
  for (const a of ACTIONS) {
    assert.ok(
      a.http === null || (Array.isArray(a.http) && a.http.length === 2),
      `action ${a.id} 的 http 必须是 [method, pattern] 或 null`
    );
  }
});

test('每条 HTTP 路由都能由某条 CLI 命令触达（核心保证）', () => {
  // 由于 action 同时声明 cli 与 http，这一点在结构上已成立；
  // 这条断言用来防止将来有人绕过 action 表、直接在 runtime 里挂野路由。
  const httpActions = ACTIONS.filter((a) => a.http);
  assert.ok(httpActions.length > 0, '没有任何 HTTP 路由，面板将无法工作');
  for (const a of httpActions) {
    assert.ok(cliPathsOf(a).length > 0, `路由 ${a.http.join(' ')} 没有等价 CLI 命令`);
  }
});

test('带 view 的模块都在前端视图注册表登记，且反向无孤儿', () => {
  const withView = MODULES.filter((m) => m.view).map((m) => m.id).sort();
  const registered = [...frontendViewIds].sort();
  assert.deepEqual(
    registered,
    withView,
    `前端视图注册表 (${registered}) 与带 view 的模块 (${withView}) 不一致`
  );
});

test('前端注册表里的视图文件真实存在', () => {
  for (const id of frontendViewIds) {
    const p = join(MODULES_DIR, id, 'view.jsx');
    assert.doesNotThrow(() => readFileSync(p), `视图注册表引用了不存在的文件: ${p}`);
  }
});

// ---- 视图里调用的每个 /api 路径都必须真实存在于路由表 ----
// 这条抓的是「面板调了个不存在的接口」——改造前没有这层保护，
// 前端写错路径只会在用户点击时 404。

function routeSegments([, pattern]) {
  return pattern.split('/').filter(Boolean);
}

function pathMatchesRoute(pathSegs, routeSegs) {
  if (pathSegs.length !== routeSegs.length) return false;
  return routeSegs.every((r, i) => {
    const p = pathSegs[i];
    return r.startsWith(':') || p.startsWith(':') || r === p;
  });
}

test('视图调用的每个 /api 路径都有对应路由', () => {
  const routes = ACTIONS.filter((a) => a.http).map((a) => a.http);
  const problems = [];

  for (const id of frontendViewIds) {
    const src = readFileSync(join(MODULES_DIR, id, 'view.jsx'), 'utf8');
    // 抓 '/api/...' 与 `/api/...` 两种字面量；模板变量 ${x} 归一为 :param
    for (const m of src.matchAll(/['"`](\/api\/[^'"`\s]*)['"`]/g)) {
      const raw = m[1];
      const clean = raw.split('?')[0].replace(/\$\{[^}]+\}/g, ':param');
      if (!clean.startsWith('/api/')) continue;
      const segs = clean.split('/').filter(Boolean);
      const hit = routes.some((r) => pathMatchesRoute(segs, routeSegments(r)));
      if (!hit) problems.push(`${id}/view.jsx → ${raw}`);
    }
  }

  assert.deepEqual(problems, [], `这些接口调用没有对应路由:\n${problems.join('\n')}`);
});

test('每条 action 的 CLI 路径都能被运行器解析回它自己', async () => {
  // 这是「命令真的敲得出来」的零副作用证明：只走命令匹配，不执行任何 action，
  // 因此不会误装 skill 或起服务。匹配算法一改坏（比如别名竞争、最长匹配失效），
  // 这里立刻失败。
  const { resolveCommand } = await import(
    pathToFileURL(join(ROOT, 'src', 'runtime', 'cli.js')).href
  );

  for (const a of ACTIONS) {
    for (const path of cliPathsOf(a)) {
      const hit = resolveCommand(path);
      assert.ok(hit, `命令 ${path.join(' ')} 无法被解析`);
      assert.equal(
        hit.cmd.id,
        a.id,
        `命令 ${path.join(' ')} 被解析到了 ${hit.cmd.id}，而非声明的 ${a.id}`
      );
      assert.deepEqual(hit.rest, [], `命令 ${path.join(' ')} 解析后仍有剩余参数`);
    }
  }
});

test('内置命令（serve/help/version）也在命令表里', async () => {
  const { ALL_COMMANDS } = await import(
    pathToFileURL(join(ROOT, 'src', 'runtime', 'cli.js')).href
  );
  const ids = ALL_COMMANDS.map((c) => c.id);
  for (const b of ['serve', 'help', 'version']) {
    assert.ok(ids.includes(b), `内置命令 ${b} 不在命令表里，将无法被解析`);
  }
});

// ---- CRUD 完备性 ----
// 声明了 `resource` 的模块承诺提供完整的 CRUD，且**两端都可调用**。
//
// 这条检查的价值在于：漏掉「改」或「删」这种缺失不会自己冒出来——
// 模块照样能跑、测试照样绿，直到某个用户想改一条记录时才发现没这个功能。
// 而「只在 CLI 有、HTTP 没有」（或反之）更隐蔽：一端测过了就以为做完了。

const CRUD_OPS = {
  list: '查（列表）',
  get: '查（单条）',
  create: '增',
  update: '改',
  remove: '删',
};

// 约定：资源 `X` 的五个操作 id 为 X.list / X.get / X.add / X.update / X.remove
const CRUD_VERB = { list: 'list', get: 'get', create: 'add', update: 'update', remove: 'remove' };

test('声明了 CRUD 资源的模块，五个操作齐备且两端可调用', () => {
  const resources = MODULES.filter((m) => m.resource);
  assert.ok(resources.length > 0, '没有任何模块声明 resource，这条检查就形同虚设');

  const problems = [];
  for (const m of resources) {
    for (const [op, verb] of Object.entries(CRUD_VERB)) {
      const id = `${m.resource}.${verb}`;
      const action = ACTIONS.find((a) => a.id === id);

      if (!action) {
        problems.push(`${m.id}: 缺「${CRUD_OPS[op]}」操作（应为 action id "${id}"）`);
        continue;
      }
      if (!cliPathsOf(action).length) problems.push(`${m.id}: ${id} 缺 CLI 命令`);
      if (!action.http) problems.push(`${m.id}: ${id} 缺 HTTP 路由（面板无法调用）`);
      if (!action.run) problems.push(`${m.id}: ${id} 没有 run`);
    }
  }
  assert.deepEqual(problems, [], `CRUD 不完备:\n${problems.join('\n')}`);
});

test('CRUD 路由的形状对得上语义', () => {
  // 形状不对时功能可能还能跑，但语义已经错了：
  // list 带 :param 说明它其实是「查单条」；update 没有 :param 说明它其实是「改全部」。
  const segs = (p) => p.split('/').filter(Boolean);
  const hasParam = (p) => segs(p).some((s) => s.startsWith(':'));

  for (const m of MODULES.filter((m) => m.resource)) {
    const httpOf = (op) => ACTIONS.find((a) => a.id === `${m.resource}.${CRUD_VERB[op]}`).http;

    assert.equal(hasParam(httpOf('list')[1]), false, `${m.id}: list 路由不应含 :param`);
    for (const op of ['get', 'update', 'remove']) {
      assert.ok(hasParam(httpOf(op)[1]), `${m.id}: ${op} 路由必须含 :param（要能定位单条）`);
    }
  }
});

test('CRUD 的 HTTP 方法符合语义', () => {
  // 方法用错不会让功能失效，但会让 API 语义混乱、也让 agent 难以推断。
  const expected = { list: 'GET', get: 'GET', create: 'POST', update: 'PATCH', remove: 'DELETE' };
  for (const m of MODULES.filter((m) => m.resource)) {
    for (const [op, method] of Object.entries(expected)) {
      const action = ACTIONS.find((a) => a.id === `${m.resource}.${CRUD_VERB[op]}`);
      if (!action || !action.http) continue;
      assert.equal(
        action.http[0],
        method,
        `${action.id} 的 HTTP 方法应为 ${method}，实际是 ${action.http[0]}`
      );
    }
  }
});

// ---- 命令 ↔ 路由的双向可发现 ----
// 单向（CLI 命令 → 路由）在结构上已成立；这里保证反向也能查到——
// agent 常常是先从端点出发的（面板 devtools 里看到一个请求，要问怎么用 CLI 重放）。

const routesAction = ACTIONS.find((a) => a.id === 'system.routes');

test('routes 反查：每条 HTTP 路由都能定位回自己的命令', async () => {
  assert.ok(routesAction, 'system.routes 不存在');
  const httpActions = ACTIONS.filter((a) => a.http);
  assert.ok(httpActions.length > 20, `带路由的 action 太少（${httpActions.length}）`);

  const missed = [];
  for (const a of httpActions) {
    const [method, pattern] = a.http;
    // 把 :param 换成具体值，模拟真实端点（如 DELETE /api/repos/r_abc）
    const concrete = pattern.replace(/:[^/]+/g, 'sample');
    const hit = await routesAction.run({ http: `${method} ${concrete}` });
    if (!hit.some((c) => c.id === a.id)) missed.push(`${method} ${concrete} → ${a.id}`);
  }
  assert.deepEqual(missed, [], `这些路由反查不到对应命令:\n${missed.join('\n')}`);
});

// CRITICAL：字面量段必须压过同长度的 :param 段——本机实测过 `compareRoutes`
// 旧版会让 `/api/env/list` 走到 `:name`，把 list 当变量名去查。
// 这里挑几对「字面量 vs :param」冲突的路径，断言字面量那条胜出。
const LITERAL_VS_PARAM_FIXTURES = [
  { req: 'GET /api/env/status',     expectId: 'env.status' },
  { req: 'GET /api/env/path',       expectId: 'env.path.list' },
  { req: 'GET /api/env/snapshots',  expectId: 'env.snapshot.list' },
  { req: 'POST /api/env/snapshots', expectId: 'env.snapshot.save' },
];

test('路由排序：字面量段压过同长度的 :param 段', async () => {
  const { handleApi } = await import(
    pathToFileURL(join(ROOT, 'src', 'runtime', 'api.js')).href
  );
  for (const f of LITERAL_VS_PARAM_FIXTURES) {
    const [method, path] = f.req.split(' ');
    // 伪造最小 req / res（handleApi 不读 req.body，只看 method + url + pathname）
    const req = { method, headers: {}, url: path, on: () => {}, once: () => {} };
    const body = [];
    let status;
    const res = {
      writeHead: (s) => { status = s; return res; },
      end: (b) => { body.push(b ?? ''); return res; },
    };
    await handleApi(req, res, { pathname: path });

    let payload = {};
    try { payload = JSON.parse(body.join('') || '{}'); } catch {}

    // 命中的应是字面量那条 action；命中错时 status=404 且 message 含「接口不存在」
    if (status === 404 || /接口不存在/.test(payload.error || '')) {
      assert.fail(`${f.req} 没命中路由（${payload.error || status}）—— ${f.expectId} 应胜出`);
    }
    // 进一步：不该把字面量当变量名去查（那是被 :name 抢走时的错误信息）
    const tail = path.split('/').pop();
    assert.ok(
      !new RegExp(`不存在: ${tail}`).test(payload.error || ''),
      `${f.req} 走到了 :name，把 "${tail}" 当变量名去查`,
    );
  }
});

test('routes 正查：--module 过滤，且纯 CLI 命令如实标注 http:null', async () => {
  const repos = await routesAction.run({ module: 'repos' });
  assert.ok(repos.length > 0);
  assert.ok(repos.every((c) => c.module === 'repos'));
  assert.ok(repos.every((c) => c.http && c.http.method && c.http.path));

  const all = await routesAction.run({});
  const { ALL_COMMANDS } = await import(
    pathToFileURL(join(ROOT, 'src', 'runtime', 'cli.js')).href
  );
  // 对照表覆盖**全部**命令，含 serve/help/version 这类平台命令——
  // 否则 `nx-rh routes` 与 `nx-rh help --json` 会给出两个长度不同的"命令表"。
  assert.equal(all.length, ALL_COMMANDS.length, '命令表应覆盖全部命令（actions + 平台命令）');
  assert.ok(all.some((c) => c.module === 'platform'), '平台命令也应出现在对照表里');

  const cliOnly = all.filter((c) => !c.http);
  assert.ok(cliOnly.length > 0, '应当存在纯 CLI 命令（如 setting get），否则 http:null 这条路没被走到');
  assert.ok(cliOnly.every((c) => c.command.startsWith('nx-rh ')));
});

test('routes 与 help --json 覆盖同一批命令', async () => {
  const routes = await routesAction.run({});
  // help 的 run 返回同形状的条目；两者必须同源同长，否则「命令表」就有了两份。
  const { ALL_COMMANDS } = await import(
    pathToFileURL(join(ROOT, 'src', 'runtime', 'cli.js')).href
  );
  const viaHelp = await ALL_COMMANDS.find((c) => c.id === 'help').run({ topic: undefined });
  assert.equal(viaHelp.length, routes.length);
  assert.deepEqual(
    viaHelp.map((e) => e.id).sort(),
    routes.map((e) => e.id).sort()
  );
});

test('routes 正查：未知模块与无匹配端点都给出可行动的报错', async () => {
  await assert.rejects(() => routesAction.run({ module: 'nope' }), /未知模块.*可用:/);
  await assert.rejects(() => routesAction.run({ http: 'POST /api/nope' }), /没有路由匹配.*nx-rh routes/);
  await assert.rejects(() => routesAction.run({ http: 'not-a-path' }), /需形如/);
});

test('help 用法串能由声明完整生成（含参数与 flag）', () => {
  const add = ACTIONS.find((a) => a.id === 'repo.add');
  const usage = usageOf(add);
  assert.match(usage, /^nx-rh repo add <path>/);
  assert.match(usage, /\[--tags <tags>\]/);

  // agent 失败分类依赖 help 里出现这条命令名（也见于 assets/repo-hub 的用法文档）
  const allUsage = ACTIONS.map(usageOf).join('\n');
  assert.ok(allUsage.includes('nx-rh repo add'), 'help 必须包含 repo add');
});
