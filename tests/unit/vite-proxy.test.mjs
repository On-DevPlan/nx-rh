// 代理分流规则。
//
// 背景：Vite 的 root 是 src/web/frontend/，源码文件会暴露成 URL，
// 于是 src/web/frontend/api/client.js 被请求为 /api/client.js——与后端接口前缀 /api 撞车。
// 没有分流时，前端自己的模块请求会被代理到后端，拿到 404 JSON，import 失败，
// **整个面板在 dev 模式起不来**（生产构建不走代理，所以只有 dev 会中招）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldServeLocally } from '../../vite.config.js';

test('前端模块请求交回 Vite，不被代理吞掉', () => {
  // 就是这条路径触发了原始故障
  assert.equal(shouldServeLocally('/api/client.js'), '/api/client.js');
  assert.ok(shouldServeLocally('/components/ui.jsx'));
  assert.ok(shouldServeLocally('/main.jsx'));
  assert.ok(shouldServeLocally('/style.css'));
  assert.ok(shouldServeLocally('/assets/logo.svg'));
});

test('查询串不影响判定', () => {
  assert.ok(shouldServeLocally('/api/client.js?v=123'));
  assert.equal(shouldServeLocally('/api/gh/view?repo=owner/repo'), undefined);
});

test('真实接口仍然走代理', () => {
  assert.equal(shouldServeLocally('/api/bootstrap'), undefined);
  assert.equal(shouldServeLocally('/api/repos'), undefined);
  assert.equal(shouldServeLocally('/api/repos/status'), undefined);
  assert.equal(shouldServeLocally('/api/skills/platform'), undefined);
  assert.equal(shouldServeLocally('/api/repos/r_mu3qdfbnp236g'), undefined);
});

test('空输入不抛错', () => {
  assert.equal(shouldServeLocally(''), undefined);
  assert.equal(shouldServeLocally(undefined), undefined);
});
