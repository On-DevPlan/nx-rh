// 平台适配器表回归：新增豆包（Doubao）后，id / 别名 / 两级落点必须正确解析。
// 豆包的特殊点：用户级目录是「非隐藏 + 首字母大写」的 ~/Doubao/skills，
// 与其它平台 ~/.<id>/skills 的隐藏目录约定不同——单测把这条平台差异锁死。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'nxrh-adapt-'));
const home = join(tmp, 'home');
process.env.HOME = home;
process.env.USERPROFILE = home; // os.homedir() 在 Windows 上读它

const {
  ADAPTERS,
  normalizePlatformId,
  adapterById,
  targetDirFor,
  platformNames,
} = await import('../../src/modules/skills/adapters.js');

test('豆包适配器存在且字段正确', () => {
  const a = adapterById('doubao');
  assert.ok(a, 'doubao 适配器应存在');
  assert.equal(a.id, 'doubao');
  assert.equal(a.dir, '.doubao/skills');
  assert.equal(a.globalDir, 'Doubao/skills');
});

test('豆包别名归一且大小写不敏感', () => {
  assert.equal(normalizePlatformId('doubao'), 'doubao');
  assert.equal(normalizePlatformId('DOUBAO'), 'doubao');
});

test('豆包用户级落点为非隐藏、大写目录', () => {
  assert.equal(targetDirFor('doubao', 'user', tmp), join(home, 'Doubao', 'skills'));
});

test('豆包项目级落点为隐藏目录', () => {
  const proj = join(tmp, 'proj');
  assert.equal(targetDirFor('doubao', 'project', proj), join(proj, '.doubao', 'skills'));
});

test('未知平台归一为空、all 透传', () => {
  assert.equal(normalizePlatformId('nope'), '');
  assert.equal(normalizePlatformId('all'), 'all');
  assert.equal(adapterById('all'), null);
});

test('默认平台保留且适配器 id 无重复', () => {
  for (const id of ['claude-code', 'workbuddy']) {
    assert.ok(platformNames().includes(id), `${id} 应保留`);
  }
  assert.equal(ADAPTERS.length, new Set(ADAPTERS.map((a) => a.id)).size);
});
