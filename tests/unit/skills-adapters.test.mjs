// 平台适配器表回归：新增豆包（Doubao）、千问办公（Qianwen）后，id / 别名 / 两级落点必须正确解析。
// 豆包的特殊点：用户级目录是「非隐藏 + 首字母大写」的 ~/Doubao/skills，
// 与其它平台 ~/.<id>/skills 的隐藏目录约定不同——单测把这条平台差异锁死。
// 千问办公的特殊点：官方只有用户级 ~/.qwenworkcn/skills，项目级那格是占位（产品不读）。
// Trae 国内版的特殊点：两级目录名不同——项目级 .trae/skills（两版共用）、用户级 ~/.trae-cn/skills。
// Qoder 的特殊点：两级目录同名 .qoder/skills（官方两级都写明，用户级本机实测）；中国版落点未实测。
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

test('千问办公适配器存在，用户级落点为 ~/.qwenworkcn/skills', () => {
  const a = adapterById('qianwen');
  assert.ok(a, 'qianwen 适配器应存在');
  assert.equal(a.id, 'qianwen');
  assert.equal(a.dir, '.qwenworkcn/skills');
  assert.equal(a.globalDir, '.qwenworkcn/skills');
  assert.equal(targetDirFor('qianwen', 'user', tmp), join(home, '.qwenworkcn', 'skills'));
});

test('千问办公别名（含产品英文名）全部归一到 qianwen', () => {
  for (const al of ['qianwen', 'qwenwork', 'qwen', 'qw', 'QWENWORK', 'Qianwen']) {
    assert.equal(normalizePlatformId(al), 'qianwen', `${al} 应归一为 qianwen`);
  }
});

test('Trae 国内版两级目录名不同：项目 .trae / 用户 .trae-cn', () => {
  const a = adapterById('trae-cn');
  assert.ok(a, 'trae-cn 适配器应存在');
  assert.equal(a.dir, '.trae/skills');
  assert.equal(a.globalDir, '.trae-cn/skills');
  const proj = join(tmp, 'proj2');
  assert.equal(targetDirFor('trae-cn', 'user', tmp), join(home, '.trae-cn', 'skills'));
  assert.equal(targetDirFor('trae-cn', 'project', proj), join(proj, '.trae', 'skills'));
});

test('Trae 裸名 trae 归一到国内版（本机只装它）', () => {
  for (const al of ['trae-cn', 'trae', 'TRAE', 'Trae-CN']) {
    assert.equal(normalizePlatformId(al), 'trae-cn', `${al} 应归一为 trae-cn`);
  }
});

test('Qoder 两级目录同名：项目与用户都是 .qoder/skills', () => {
  const a = adapterById('qoder');
  assert.ok(a, 'qoder 适配器应存在');
  assert.equal(a.id, 'qoder');
  assert.equal(a.dir, '.qoder/skills');
  assert.equal(a.globalDir, '.qoder/skills');
  const proj = join(tmp, 'proj3');
  assert.equal(targetDirFor('qoder', 'user', tmp), join(home, '.qoder', 'skills'));
  assert.equal(targetDirFor('qoder', 'project', proj), join(proj, '.qoder', 'skills'));
});

test('Qoder 别名归一到 qoder', () => {
  for (const al of ['qoder', 'Qoder', 'QODER']) {
    assert.equal(normalizePlatformId(al), 'qoder', `${al} 应归一为 qoder`);
  }
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
