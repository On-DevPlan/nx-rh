// 端口协商的统一口径测试（core/serve-port.js）。
//
// 覆盖四件事：自动开浏览器的开关（--no-open 与 NX_SERVE_NO_OPEN）、
// 探测「不是面板」的端口、找空闲端口、端口冲突的两分支决策（reuse / shift）。
//
// reuse 分支必须用**本项目真实的 APP_NAME**——用别的名字测，
// 测到的其实是 shift 分支，坑就藏在这里。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';

import {
  NO_OPEN_ENV,
  autoOpenEnabled,
  probePanel,
  findFreePort,
  resolvePortConflict,
  describeOccupant,
} from '../../src/core/serve-port.js';
import { APP_NAME } from '../../src/core/paths.js';

// ---- 测试用的临时服务 ----

// 只占端口、不说 HTTP 协议的东西：探测它必须得到 null。
function startSilentServer() {
  const server = net.createServer((socket) => socket.destroy());
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// 假面板：只在 /api/bootstrap 上按 payload 应答。
function startFakePanel(payload) {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/bootstrap') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, data: payload }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// 关服务：先掐掉 keep-alive 连接再 close，否则 fetch 的连接会让 close 挂住。
async function close(server) {
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await new Promise((resolve) => server.close(() => resolve()));
}

// 环境变量的临时改写：测完恢复原值，别把后面的用例带偏。
function withEnv(value, fn) {
  const prev = process.env[NO_OPEN_ENV];
  if (value === undefined) delete process.env[NO_OPEN_ENV];
  else process.env[NO_OPEN_ENV] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[NO_OPEN_ENV];
    else process.env[NO_OPEN_ENV] = prev;
  }
}

// ---- autoOpenEnabled ----

test('autoOpenEnabled: 环境变量未设 + 无 flag → 允许开浏览器', () => {
  withEnv(undefined, () => {
    assert.equal(autoOpenEnabled(false), true);
    assert.equal(autoOpenEnabled(undefined), true);
  });
});

test(`autoOpenEnabled: ${NO_OPEN_ENV}=1 / true / yes / on → 不开浏览器`, () => {
  for (const v of ['1', 'true', 'yes', 'on', 'ON', 'Yes']) {
    withEnv(v, () => {
      assert.equal(autoOpenEnabled(false), false, `${NO_OPEN_ENV}=${v} 应关闭自动开浏览器`);
    });
  }
});

test(`autoOpenEnabled: ${NO_OPEN_ENV}=0 → 仍允许开浏览器（0 不算真值）`, () => {
  withEnv('0', () => {
    assert.equal(autoOpenEnabled(false), true);
  });
});

test('autoOpenEnabled: --no-open 独立生效（环境变量没设也关）', () => {
  withEnv(undefined, () => {
    assert.equal(autoOpenEnabled(true), false);
  });
});

// ---- probePanel ----

test('probePanel: 不是面板的端口 → null', async () => {
  const { server, port } = await startSilentServer();
  try {
    assert.equal(await probePanel(port), null);
  } finally {
    await close(server);
  }
});

test('probePanel: 面板端口 → 返回 bootstrap 负载', async () => {
  const { server, port } = await startFakePanel({ app: { name: APP_NAME, version: '0.0.0' } });
  try {
    const payload = await probePanel(port);
    assert.ok(payload, '应拿到 bootstrap 负载');
    assert.equal(payload.app.name, APP_NAME);
  } finally {
    await close(server);
  }
});

// ---- findFreePort ----

test('findFreePort: 跳开被占的端口，返回的端口真能监听', async () => {
  const { server, port } = await startSilentServer();
  try {
    const next = await findFreePort(port);
    assert.ok(next > port, `应跳过被占的 ${port}，实际 ${next}`);
    await new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen(next, '127.0.0.1', () => probe.close(resolve));
    });
  } finally {
    await close(server);
  }
});

// ---- resolvePortConflict ----

test('resolvePortConflict: 端口上是本项目的面板 → reuse', async () => {
  const { server, port } = await startFakePanel({ app: { name: APP_NAME, version: '0.0.0' } });
  try {
    const decision = await resolvePortConflict(port, APP_NAME);
    assert.equal(decision.action, 'reuse');
    assert.equal(decision.port, port);
    assert.equal(decision.occupant, APP_NAME);
  } finally {
    await close(server);
  }
});

test('resolvePortConflict: 端口上是别人的面板 → shift 到下一个空闲端口', async () => {
  const { server, port } = await startFakePanel({ app: { name: 'someone-else' } });
  try {
    const decision = await resolvePortConflict(port, APP_NAME);
    assert.equal(decision.action, 'shift');
    assert.ok(decision.port > port, `应顺延到 ${port} 之后，实际 ${decision.port}`);
    assert.equal(decision.occupant, 'someone-else');
    assert.equal(describeOccupant(decision.occupant), 'someone-else');
  } finally {
    await close(server);
  }
});

test('resolvePortConflict: 占用者探测不出来 → shift，占用者记为未知服务', async () => {
  const { server, port } = await startSilentServer();
  try {
    const decision = await resolvePortConflict(port, APP_NAME);
    assert.equal(decision.action, 'shift');
    assert.ok(decision.port > port);
    assert.equal(decision.occupant, null);
    assert.equal(describeOccupant(decision.occupant), '未知服务');
  } finally {
    await close(server);
  }
});
