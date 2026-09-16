# 01 · 工程骨架：一切基于 serve

> 归属主文档 [[server-cli-web-scaffold]]。读它当你要**定目录结构**或**接一个新功能域**时。

## 一、唯一入口原则

整包只有**一个**可执行文件，其余全是模块：

```
bin/<name>.mjs          ← 唯一入口（package.json 的 bin 只指它）
```

```js
#!/usr/bin/env node
import { runCli } from '../src/runtime/cli.js';
runCli(process.argv.slice(2)).catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});
```

入口只做两件事：转发 argv、兜住未捕获的异常。
所有命令分发都在 `runtime/cli.js`——那里才是命令表。

**为什么**：多个入口 = 多份参数解析 = 迟早不一致。

## 二、目录结构（照抄）

```
bin/<name>.mjs                 唯一入口
src/
  index.js                     库入口（导出各模块 service，供程序化调用）
  core/                        零业务语义
    paths.js                   常量、存储路径、名称/路径安全校验
    errors.js                  AppError + code→HTTP/exit 唯一映射
    store.js                   状态读写：原子写 + 失效检测
    open.js                    交给 OS 的动作（开浏览器/文件管理器）
    <algorithm>.js             本项目的纯算法（diff / 解析 / …）
  modules/                     功能域，每个自包含
    system/                    聚合：bootstrap / health / routes（无视图）
    <域>/index.js              action 声明
    <域>/service.js            业务
    <域>/view.jsx              面板
  runtime/                     装配层（不含业务）
    registry.js                模块注册表 + 装载期自检
    spec.js                    action 规格：校验/强转/路由编译/用法串
    cli.js                     CLI 运行器 + help 生成
    api.js                     HTTP 路由
    server.js                  node:http：静态 + /api 委派
    <name>.js                  内置命令的实现（见下）
  web/
    frontend/                  React 源码（Vite root）
      registry.js              视图注册表
      App.jsx / store.jsx / components/ / api/client.js
    public/                    vite build 产物（gitignore）
assets/<skill名>/              随包分发的 skill（SKILL.md + references/）
tests/
  unit/                        单元 + 一致性断言
  smoke.mjs                    端到端：CLI 全链路 + API + 静态页
eslint.config.js               分层约束在这里落地
vite.config.js
```

## 三、serve 驱动一切

`serve` 是**唯一常驻命令**，Web 面板与 HTTP API 都由它提供：

```js
// runtime/server.js —— 零依赖，只用 node:http
export function startServer({ port, host = '127.0.0.1' } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    return serveStatic(url.pathname, res);
  });
  return new Promise((ok, no) => {
    server.once('error', no);
    server.listen(port, host, () => ok(server));
  });
}
```

三个必须做到的点：

1. **默认只绑 `127.0.0.1`**。这是本机工具，不要暴露到局域网。
2. **静态服务做 resolve 后前缀校验**，别用正则剥 `..`：
   ```js
   const file = resolve(PUBLIC_DIR, rel);
   if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + sep)) return forbidden();
   ```
3. **写操作校验 Origin**。服务在 127.0.0.1，但用户浏览器里的任意页面都能向它发请求：
   ```js
   // 跨域请求浏览器必带 Origin；非浏览器客户端（curl/agent/测试）不带，故放行
   if (!origin || ['127.0.0.1','localhost','::1'].includes(new URL(origin).hostname)) allow();
   ```

### serve 命令本身

```js
{
  id: 'serve',
  cli: ['serve'],
  summary: '启动 Web 面板',
  flags: { port: { type: 'number', default: 7800 }, 'no-open': { type: 'boolean' } },
  run: async (ctx) => { /* 起服务 + 打印地址 + SIGINT 优雅退出 */ },
}
```

启动后打印三行：面板地址、存储路径、`--json` 提示。
`--no-open` 是给开发与 CI 用的——自动化场景不能弹浏览器。

## 四、dev 与 prod 两种模式

```js
// vite.config.js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 前端源码根下的文件会被暴露成 URL：src/web/frontend/api/client.js → /api/client.js。
// 而 /api 又是后端接口前缀，于是**前端自己的模块请求会被代理吞掉**——
// 浏览器拿到一坨 JSON、import 失败，dev 模式下面板直接起不来。
//
// 这是 Vite root 与服务端前缀的天然冲突：靠「目录别叫 api」这种约定防不住，
// 新增一个同名目录就会重现。所以按「是不是前端资源」决定走不走代理。
const FRONTEND_ASSET = /\.(jsx?|mjs|cjs|tsx?|css|map|svg|png|jpe?g|webp|ico|woff2?)$/i;

export function shouldServeLocally(url) {
  const path = String(url || '').split('?')[0];
  return FRONTEND_ASSET.test(path) ? path : undefined;   // 真值 = 交回 Vite
}

export default defineConfig({
  root: 'src/web/frontend',
  plugins: [react()],
  build: { outDir: '../public', emptyOutDir: true },
  server: {
    port: 5180,
    proxy: { '/api': { target: 'http://127.0.0.1:7800', bypass: (req) => shouldServeLocally(req.url) } },
  },
});
```

| 模式 | 起什么 | 静态文件从哪来 |
| --- | --- | --- |
| dev | `vite`（:5180）+ `<name> serve --no-open`（:7800） | Vite dev server，`/api` 代理到 7800 |
| prod | `<name> serve` | `src/web/public/`（`vite build` 产物，gitignore） |

**server.js 对构建工具零感知**——它只服务 `public/` 目录，不管是 dev 还是 prod。
这条让"发布产物"和"本地开发"共用同一个入口，不会出现"dev 能跑、打包后白屏"。

### ⚠️ 代理前缀与源码目录名撞车（只在 dev 模式出现）

**上面那段 `bypass` 不是可选的。** 没有它会发生什么：

- 前端把 `src/web/frontend/api/client.js` 暴露成 `/api/client.js`
- 代理规则 `/api` 把它当成接口请求，转发到后端
- 后端没有这条路由 → 返回 `404 {"ok":false,...}`（或后端没起时 `ECONNREFUSED`）
- 浏览器拿 JSON 当 ES 模块解析 → `import` 失败 → **整页白屏**

**为什么生产构建没事**：`vite build` 不打代理，所以这个 bug 只在 `pnpm run dev` 下出现。
而如果平时只用 `pnpm start`（构建产物）验证，它会一直潜伏到某天有人开 dev 模式。

**为什么不能靠命名约定防**：约定是"前端源码顶层目录别叫 `api`"——但只要有人新增一个
同名目录，问题就回来了，而且报错信息（`ECONNREFUSED` 或 404）离根因很远。

**验证方式**：dev 模式起好后，直接请求那个模块路径，必须拿到 JS：

```bash
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" http://localhost:5180/api/client.js
# 期望 200 text/javascript；若得到 404 application/json 就是没分流
```

把 `shouldServeLocally` 导出并单测，这条规则才不会被后续改配置的人顺手删掉。

`package.json` 的脚本：

```json
{
  "scripts": {
    "dev": "vite",
    "dev:serve": "node bin/<name>.mjs serve --no-open",
    "build": "vite build",
    "start": "pnpm run build && node bin/<name>.mjs serve",
    "test": "pnpm run lint && pnpm run build && node tests/smoke.mjs && node --test \"tests/unit/*.test.mjs\""
  }
}
```

## 五、零运行时依赖

服务端只用 Node 内置模块，**生产依赖只有 react / react-dom**。

理由：`npx` 场景下用户在等下载。依赖树一大，首次体验就毁了。
`gh`、`git` 这类外部能力走 `spawn` 调用用户已有的 CLI，不打包它们。

```json
{
  "type": "module",
  "bin": { "<name>": "bin/<name>.mjs" },
  "files": ["bin/", "src/", "assets/", "README.md", "CHANGELOG.md"],
  "engines": { "node": ">=18.17" }
}
```

`engines` 要写上：用到了 `structuredClone`、`node --test`、顶层 await。

## 六、核心三件套（core/）

阶段 1 就该建好，后面所有模块都依赖它们：

| 文件 | 职责 | 关键点 |
| --- | --- | --- |
| `paths.js` | 常量、存储路径、安全校验 | 存储路径要能用**环境变量覆盖**（见 [[04-state-storage]]） |
| `store.js` | 状态读写 | 原子写 + 缓存失效（见 [[04-state-storage]]） |
| `errors.js` | AppError + code 映射 | 映射只写一处（见 [[00-design-and-verify]]） |

再往下按项目需要加：`open.js`（开浏览器/文件管理器）、
以及本项目的纯算法文件（差分、解析、计算…）——**纯函数放 core，方便单测**。

## 七、踩过的坑

| 坑 | 后果 | 正确做法 |
| --- | --- | --- |
| 一个项目多个 bin 入口 | 多份参数解析，迟早不一致 | 只有一个 bin，其余都是模块 |
| serve 只用 dev 模式验证 | 打包后白屏 | `pnpm start` 必须能在干净环境跑通 |
| **代理前缀与前端源码目录同名**（`/api` vs `src/.../api/`） | dev 模式整页白屏，报错却是 `ECONNREFUSED` 或 404，离根因很远 | 代理加 `bypass` 分流；单测钉住（见上节） |
| 反过来只用 `pnpm start` 验证、从不开 dev | 代理分流这类只影响 dev 的 bug 长期潜伏 | 交付前**两种模式都跑一遍** |
| 忘记把 `public/` 加进 `.gitignore` | 构建产物入库，冲突不断 | 产物、`node_modules`、临时工具目录都忽略 |
| 用了 `node:test` 却没写 `engines` | 老版本 Node 上直接崩 | 声明 `engines.node` |
| 零依赖原则中途破功 | npx 首次下载变慢，体验毁掉 | 需要编译的依赖一律不做，改用系统已有 CLI |
