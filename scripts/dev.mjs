// 一条命令起 dev：vite（5180，HMR + 代理）+ serve（7800，真实后端）。
//
// 设计要点（详见 references/01-bootstrap-serve-first.md 第四节）：
//   - 两个进程是因为 vite 要做实时 JSX 转换，serve 只服务构建产物。
//     强行合并成一个进程 = 把 HMR 编进 prod 入口，破坏「prod 路径不依赖构建工具」的隔离。
//   - vite ready 之后才拉 serve：避免 serve 先起来处理一个 vite 还没就绪的代理请求时
//     出现的早期 502 / ECONNREFUSED 噪音。
//   - 一个 ctrl-c 关两个：父进程把 SIGINT / SIGTERM 转发给两个子进程，自己等它们都退出。
//   - 直接 spawn node 二进制，**绕过 npm.cmd 这层 wrapper**——避免在 Windows 上
//     `npm.cmd` 把脚本名当 npm 自身参数而不是要运行的脚本（已知坑）。
//
// 这是 dev-only 工具。prod (`pnpm run start`) 不动，仍然只起 serve。
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
// dev.mjs 住在 scripts/ 下，但 node_modules 在项目根——上一层
const PROJECT_ROOT = join(ROOT, '..');
const NODE = process.execPath;
const VITE_BIN = join(PROJECT_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const SERVE_BIN = join(PROJECT_ROOT, 'bin', 'cli.mjs');

function spawnColored(name, command, args, color) {
  const child = spawn(command, args, {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: color || '1' },
  });
  child.stdout.on('data', (d) => process.stdout.write(`[${name}] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[${name}] ${d}`));
  return child;
}

function waitForVite(port, timeoutMs = 15000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 500 }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() - t0 > timeoutMs) reject(new Error(`vite 在 ${timeoutMs}ms 内未就绪`));
        else setTimeout(tick, 200);
      });
    };
    tick();
  });
}

// vite 8 + Node 18+ 默认在 IPv6 (`::1`) 监听，127.0.0.1 显式 host 才能匹配。
// 不传 --host 时日志显示 `localhost` 但浏览器/curl 走 IPv4 会拒。
const vite = spawnColored(
  'vite',
  NODE,
  [VITE_BIN, '--host', '127.0.0.1'],
  'cyan',
);

let shuttingDown = false;
const shutdown = (code = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  if (!vite.killed) vite.kill('SIGTERM');
  if (serve && !serve.killed) serve.kill('SIGTERM');
  setTimeout(() => process.exit(code), 3000);
};
// 同时监听 SIGINT（ctrl-c）与 SIGHUP（终端关闭）。`pnpm run dev` 走 npm.cmd 时，
// npm.cmd 会把 SIGINT 透传到 Node 子进程，但**不会**透传到非 npm 派生的孙子进程。
// 所以 npm.cmd wrapper 在 ctrl-c 时可能直接退出，留 dev.mjs 兜着子进程。
process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));
process.on('SIGHUP', () => shutdown(129));
// npm.cmd wrapper 退出会关掉 stdio，让 Node 进程收到 SIGHUP 之外的信号很不可靠。
// 直接监听 stdin 关闭：npm.cmd 退 → dev.mjs 的 stdin pipe 断 → 这里收到 exit → 收尾子进程。
process.stdin.on('close', () => shutdown(130));

// vite 就绪后再拉 serve —— 顺序反过来会出现 vite ready 信息被 serve 早期噪音吞掉
try {
  await waitForVite(5180);
} catch (e) {
  console.error('[dev] ' + e.message);
  shutdown(1);
}

// 直接 spawn node 而非 npm run dev:serve：后者经 npm.cmd 会丢参
const serve = spawnColored('serve', NODE, [SERVE_BIN, 'serve', '--no-open'], 'green');

vite.on('exit', (code) => { if (code !== 0 && code !== null && !shuttingDown) shutdown(code); });
serve.on('exit', (code) => { if (code !== 0 && code !== null && !shuttingDown) shutdown(code); });