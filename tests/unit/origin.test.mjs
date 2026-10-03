// 写操作 Origin 校验（A01 §三.3）：服务只绑 127.0.0.1，但浏览器里任意页面都能向它发请求。
// 浏览器跨域写请求必带 Origin；本机程序（curl / agent / 测试）不带，故放行。
import test from 'node:test';
import assert from 'node:assert/strict';
import { originAllowed } from '../../src/runtime/api.js';

const req = (method, origin) => ({ method, headers: origin ? { origin } : {} });

test('读请求一律放行（无论 Origin）', () => {
  assert.equal(originAllowed(req('GET', 'http://evil.example.com')), true);
  assert.equal(originAllowed(req('GET')), true);
});

test('本机程序不带 Origin 的写请求放行（curl / agent）', () => {
  assert.equal(originAllowed(req('POST')), true);
  assert.equal(originAllowed(req('DELETE')), true);
});

test('本机 Origin 的写请求放行（面板本身）', () => {
  assert.equal(originAllowed(req('POST', 'http://127.0.0.1:7800')), true);
  assert.equal(originAllowed(req('POST', 'http://localhost:5180')), true);
  assert.equal(originAllowed(req('POST', 'http://[::1]:7800')), true);
});

test('外部 Origin 的写请求拒绝（CSRF / DNS rebinding）', () => {
  assert.equal(originAllowed(req('POST', 'http://evil.example.com')), false);
  assert.equal(originAllowed(req('PATCH', 'https://127.0.0.1.evil.example.com')), false);
  assert.equal(originAllowed(req('DELETE', 'http://localhost.evil.example.com')), false);
});

test('畸形的 Origin 拒绝而不是崩溃', () => {
  assert.equal(originAllowed(req('POST', 'not a url')), false);
});
