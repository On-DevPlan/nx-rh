// 平台适配器表回归：新增豆包（Doubao）、千问办公（Qianwen）后，id / 别名 / 两级落点必须正确解析。
// 豆包的特殊点：用户级目录是「非隐藏 + 首字母大写」的 ~/Doubao/skills，
// 与其它平台 ~/.<id>/skills 的隐藏目录约定不同——单测把这条平台差异锁死。
// 千问办公的特殊点：官方只有用户级 ~/.qwenworkcn/skills，项目级那格是占位（产品不读）。
// Trae 国内版的特殊点：两级目录名不同——项目级 .trae/skills（两版共用）、用户级 ~/.trae-cn/skills。
// Qoder 的特殊点：两级目录同名 .qoder/skills（官方两级都写明，用户级本机实测）。
// Qoder 中国版（qoder-cn）的特殊点：用户级 ~/.qoder-cn/skills 本机实测；项目级无佐证是占位格。
//   裸 qoder 维持归国际版——本机两版都装，不同于 trae 只装国内版才把裸名让给 -cn。
//   显示名连写 QoderCN（不带空格）：Web 勋章取 name 首词，带空格会和国际版坍缩成同一个 "qoder"。
// DoubaoWork（豆包办公，doubao-work）的特殊点：与「豆包」同族不同产品，用户级是「非隐藏 + 产品名」
//   的 ~/DoubaoWork/skills（与 ~/Doubao/skills 同款，应用启动时自动创建）；项目级无佐证是占位格。
//   别名 doubaowork / dbw，裸 doubao 仍归「豆包」不抢。
// WorkBuddy AI（workbuddy-ai）的特殊点：与国内版 WorkBuddy（.workbuddy/skills）同族不同产品，
//   两级目录都换成 .workbuddy-ai/skills（用户级本机实测、项目级在应用的项目目录约定表里，不是占位格）。
//   裸 workbuddy / wb 仍归国内版；显示名连写 WorkBuddyAI（带空格会坍缩成同一个 workbuddy 勋章）。
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

test('Qoder 中国版用户级 ~/.qoder-cn/skills 实测，项目级是占位格', () => {
  const a = adapterById('qoder-cn');
  assert.ok(a, 'qoder-cn 适配器应存在');
  assert.equal(a.id, 'qoder-cn');
  assert.equal(a.dir, '.qoder-cn/skills');
  assert.equal(a.globalDir, '.qoder-cn/skills');
  const proj = join(tmp, 'proj4');
  assert.equal(targetDirFor('qoder-cn', 'user', tmp), join(home, '.qoder-cn', 'skills'));
  assert.equal(targetDirFor('qoder-cn', 'project', proj), join(proj, '.qoder-cn', 'skills'));
});

test('Qoder 中国版别名：qoder-cn / qodercn 归中国版，裸 qoder 维持归国际版', () => {
  for (const al of ['qoder-cn', 'qodercn', 'Qoder-CN', 'QODERCN']) {
    assert.equal(normalizePlatformId(al), 'qoder-cn', `${al} 应归一为 qoder-cn`);
  }
  assert.equal(normalizePlatformId('qoder'), 'qoder');
});

test('DoubaoWork 用户级 ~/DoubaoWork/skills 实测，项目级是占位格', () => {
  const a = adapterById('doubao-work');
  assert.ok(a, 'doubao-work 适配器应存在');
  assert.equal(a.id, 'doubao-work');
  assert.equal(a.dir, '.doubaowork/skills');
  assert.equal(a.globalDir, 'DoubaoWork/skills');
  const proj = join(tmp, 'proj5');
  assert.equal(targetDirFor('doubao-work', 'user', tmp), join(home, 'DoubaoWork', 'skills'));
  assert.equal(targetDirFor('doubao-work', 'project', proj), join(proj, '.doubaowork', 'skills'));
});

test('DoubaoWork 别名：doubao-work / doubaowork / dbw 归一，裸 doubao 仍归豆包', () => {
  for (const al of ['doubao-work', 'doubaowork', 'dbw', 'DOUBAOWORK', 'Doubao-Work']) {
    assert.equal(normalizePlatformId(al), 'doubao-work', `${al} 应归一为 doubao-work`);
  }
  assert.equal(normalizePlatformId('doubao'), 'doubao');
});

test('WorkBuddy AI（国际版）两级目录同名 .workbuddy-ai/skills', () => {
  const a = adapterById('workbuddy-ai');
  assert.ok(a, 'workbuddy-ai 适配器应存在');
  assert.equal(a.id, 'workbuddy-ai');
  assert.equal(a.dir, '.workbuddy-ai/skills');
  assert.equal(a.globalDir, '.workbuddy-ai/skills');
  const proj = join(tmp, 'proj6');
  assert.equal(targetDirFor('workbuddy-ai', 'user', tmp), join(home, '.workbuddy-ai', 'skills'));
  assert.equal(targetDirFor('workbuddy-ai', 'project', proj), join(proj, '.workbuddy-ai', 'skills'));
});

test('WorkBuddy AI 别名归一，裸 workbuddy / wb 仍归国内版', () => {
  for (const al of ['workbuddy-ai', 'workbuddyai', 'wbai', 'wb-ai', 'WorkBuddyAI', 'WB-AI']) {
    assert.equal(normalizePlatformId(al), 'workbuddy-ai', `${al} 应归一为 workbuddy-ai`);
  }
  assert.equal(normalizePlatformId('workbuddy'), 'workbuddy');
  assert.equal(normalizePlatformId('wb'), 'workbuddy');
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

test('新装 store 默认只启用 claude-code', async () => {
  const { loadStore } = await import('../../src/core/store.js');
  const s = await loadStore(join(tmp, 'no-such-store.json'));
  assert.deepEqual(s.settings.platforms, ['claude-code'], '默认平台范围只应含 claude-code');
  assert.equal(s.settings.defaultPlatform, 'claude-code');
});

test('显示名首词（Web 勋章的取法）全表唯一，同族平台不得坍缩成同一勋章', () => {
  // 与 Web 端 shortLabel（parts/shared.jsx）/ 平台范围 pill（parts/dialogs.jsx）同一套取法：
  // 去掉 ASCII 括号后缀，按空格/连字符切，取首词小写。
  const shortLabel = (a) => (a.name || a.id).replace(/\s*\(.*\)$/, '').split(/[\s-]/)[0].toLowerCase();
  const labels = ADAPTERS.map(shortLabel);
  assert.equal(labels.length, new Set(labels).size, `勋章首词重复：${labels.join(', ')}`);
  // 曾因 "Qoder CN（中国版）" 带空格坍缩成 "qoder" 的回归点
  assert.equal(adapterById('qoder-cn') && shortLabel(adapterById('qoder-cn')), 'qodercn（中国版）');
  // 同族第二个回归点：WorkBuddy 国内版 / 国际版
  assert.equal(shortLabel(adapterById('workbuddy')), 'workbuddy');
  assert.equal(shortLabel(adapterById('workbuddy-ai')), 'workbuddyai（国际版）');
});
