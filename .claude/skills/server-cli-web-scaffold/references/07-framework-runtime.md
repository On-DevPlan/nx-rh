# 07 · 框架底座与开发体验（dev 模式 / 端口 / spawn 坑）

> 归属主文档 [[server-cli-web-scaffold]] 的「框架底座与开发体验」路由。本文件是**已经跑起来**
> 的 server-cli-web 项目**日常怎么跑、怎么排错**的完整规范——读它当你要 dev、CI、
> 或排查「dev 模式某个诡异问题」时。
>
> 这些不是项目无关的「最佳实践」，是**本骨架的约束**——每一坑都来自真实事故。

## 一、什么时候读这个

- 新人接手项目，第一件事是跑起来 → 看这里
- dev 模式代理挂了 / 端口冲突 / serve 没起来 → 看这里
- 在 **Windows + Git Bash** / Node 18+ 上调试诡异问题 → 看这里
- 加新的 `scripts/*` 工具脚本 → 先看这里的「spawn 坑」

不适用：从零建项目（走主文档的「创建流程」阶段 1–6 + [[01-bootstrap-serve-first]]）。

## 二、dev 模式为什么是**两个进程**，不是一条命令

| 进程 | 端口 | 启动方式 | 职责 |
|---|---|---|---|
| **Vite** dev server | 5180 | `pnpm run dev`（自动） | JSX 实时转译、HMR、浏览器侧模块服务、`/api/*` 代理 |
| **serve** 后端 | 7800 | `pnpm run dev`（自动） | 静态文件 + `/api/*` HTTP 接口、PowerShell、文件持久化 |

**为什么不能合并**：本骨架的核心不变量是「**prod 入口纯净**」——发布产物里**没有**构建工具。
`serve` 服务 `src/web/public/`（构建产物），不知道也不关心 JSX/TSX。
要让它能 HMR，就得把 Vite 内嵌进 `serve`，那 `serve` 在 prod 里也会拖着一份编译器——既污染发布产物，又增加被构建工具新版本打破的风险。

vite dev server 是**编译器**：必须热更新源码、推送模块；那是开发体验的需求，不是 prod 服务的需求。
**两件事不耦合，就开两条进程**。

prod（`pnpm start`）依然只跑一个 `serve`——干净。

## 三、`pnpm run dev` 一条命令起全部

`scripts/dev.mjs` 是 dev 启动器：

```
pnpm run dev
  └─ scripts/dev.mjs
      ├─ 起 vite（5180，--host 127.0.0.1）
      ├─ 等 vite ready（GET / 不再 ECONNREFUSED）
      ├─ 起 serve（7800，bin/cli.mjs serve --no-open）
      └─ 一个 ctrl-c：SIGTERM → vite + serve 一起退
```

**关键决策**：

1. **vite ready 之后再起 serve**：反过来会有 vite ready 信息被 serve 早期噪音吞掉的混乱窗口。
2. **直接 spawn node 二进制，不走 `npm run`**：`spawn('npm', ['run', ...], { shell: true })` 在 Windows 上调 npm.cmd 时，参数会被 cmd.exe 重排或截断；`spawn(node, ['node_modules/vite/bin/vite.js', ...])` 绕过这层。
3. **一个 ctrl-c 关两个**：dev.mjs 注册 SIGINT/SIGTERM/SIGHUP/stdin.close，任意一个信号来都转发 `kill('SIGTERM')` 给 vite 和 serve，再 `process.exit`。
4. **prod 入口完全不变**：`pnpm start` 仍跑 `pnpm run build && node bin/cli.mjs serve`——dev 启动器**只**服务于开发模式，prod 不带这层。

## 四、端口绑定：dev 模式必须 `--host 127.0.0.1`

这是**本骨架在 Node 18+ 上最容易踩的坑**。症状：

```
[vite] ➜  Local:   http://localhost:5180/
[vite] ➜  Network: use --host to expose
$ curl http://127.0.0.1:5180/
curl: (7) Failed to connect to 127.0.0.1 port 5180
```

**为什么**：Node 18+ 默认监听 `[::1]`（IPv6），vite 8 也跟着默认。`curl 127.0.0.1` 是 IPv4，连接被拒。
日志里写的是 `localhost:5180`，因为 `localhost` 既能解析为 `127.0.0.1` 也能解析为 `::1`，
**浏览器/curl 实际走的栈不一样**就拿到不同结果——这就是 dev 模式最诡异的一类 bug。

**修法**：dev 启动器给 vite 传 `--host 127.0.0.1`：

```js
spawn(node, [join(PROJECT_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1'], ...);
```

prod 不受影响（`serve` 用 `server.listen(port, host, () => ...)`，host 默认 `127.0.0.1`）。

**验证方式**：dev 起好后 `netstat -ano | grep 5180`，看到 `127.0.0.1:5180`（不是 `[::1]:5180`）就对了。

## 五、spawn 坑：Windows + npm.cmd + Git Bash

写 dev.mjs 之类跨平台子进程脚本时，**最容易踩的三个坑**都集中在这一节。

### 1. 不要 `spawn('npm', [...], { shell: true })`

```js
// ✗ 在 Windows + Git Bash 上：参数被 cmd.exe / msys 重排 / 截断
spawn('npm', ['run', '--silent', 'dev:serve'], { shell: true });
// 在 Windows 上：「npm.cmd + dev:serve」会被误解为「npm 自己的 dev 跟 --silent 子命令」
```

```js
// ✓ 直接 spawn node 二进制，绕过 npm.cmd
const NODE = process.execPath;
const VITE_BIN = join(PROJECT_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const SERVE_BIN = join(PROJECT_ROOT, 'bin', 'cli.mjs');
spawn(NODE, [VITE_BIN, '--host', '127.0.0.1'], { stdio: ['ignore', 'pipe', 'pipe'], env: ... });
spawn(NODE, [SERVE_BIN, 'serve', '--no-open'], { stdio: ['ignore', 'pipe', 'pipe'], env: ... });
```

shell:true 的另一个代价：Node deprecation warning (`DEP0190`)，**且**参数未转义，安全性也更差。
**本骨架的子进程工具一律不走 npm.cmd**。

### 2. 路径与 cwd 校准：dev.mjs 在 `scripts/`，node_modules 在 `../`

`scripts/dev.mjs` 自身的 `__dirname` 是 `scripts/`，但 `node_modules/` 在项目根。
**写路径时不能从 `scripts/` 起，要从 PROJECT_ROOT 起**：

```js
const ROOT = dirname(fileURLToPath(import.meta.url));      // scripts/
const PROJECT_ROOT = join(ROOT, '..');                       // 项目根
const VITE_BIN = join(PROJECT_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
```

`spawn(..., { cwd: PROJECT_ROOT })` 也跟着改。不这么做的话，npm 找依赖找不到，沉默崩。

### 3. Git Bash + Windows 路径：MSYS_NO_PATHCONV

Git Bash 在 Windows 上会把 `/T` 这类参数当路径转换（`/T` → `C:/Program Files/Git/T`）：

```bash
$ taskkill /T /F /PID 1234
# taskkill: 无效选项 - 'C:/Program Files/Git/T'（应该是 /T）
```

`MSYS_NO_PATHCONV=1` 禁掉转换；或者直接用 PowerShell `Stop-Process -Id 1234 -Force`。

## 六、CI 上也走 `pnpm run dev` 吗

**不要**。CI（GitHub Actions）跑测试用 `pnpm test`，它跑的是：

```
pnpm run lint && pnpm run build && pnpm run test:smoke && pnpm run test:unit
```

`pnpm run build` 走 Vite → 产物到 `src/web/public/`。冒烟测试**单独拉起** `serve`（`tests/smoke.mjs` 自己起 server，端到端验）。**CI 不需要** dev 模式的两进程编排。

dev 启动器**只服务**人开发的本地体验。

## 七、踩过的坑

| 坑 | 后果 | 正确做法 |
| --- | --- | --- |
| vite 默认绑定 IPv6 (`::1`) | `curl 127.0.0.1:5180` 拿 000，浏览器却能打开——诡异 | dev 模式 vite 必须 `--host 127.0.0.1` |
| `spawn('npm', [...], { shell: true })` 走 npm.cmd | Windows 上参数被重排，脚本根本不跑 | 直接 `spawn(node, [binPath, ...args])`，绕 npm.cmd |
| vite 起来后立刻拉 serve，serve 早于 vite ready 处理代理 | 早期日志是 ECONNREFUSED 而非预期错误 | dev.mjs `await waitForVite(5180)` 再拉 serve |
| dev.mjs 的 ROOT 用 `__dirname`，但 vite 在 `node_modules/` | `Cannot find module` | 显式 `const PROJECT_ROOT = join(ROOT, '..')` |
| 一个 ctrl-c 只杀 npm.cmd wrapper | vite / serve 残留，要再 taskkill | dev.mjs 同时监听 SIGINT/SIGTERM/**SIGHUP**/stdin.close，转发给子进程 |
| dev 模式也想走 `pnpm run dev` 的便利但 `prod 入口必须纯净` | 把 vite 编进 serve，发布包变大且有构建工具新版本风险 | **两个进程 + dev 启动器**——`pnpm run start` 仍只跑 serve，dev 仅编入启动器，prod 包无影响 |