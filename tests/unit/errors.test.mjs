// 错误契约：code → HTTP 状态 / 退出码的映射，以及路径校验原语。
// 这两处是「一处定义、两端生效」的落点，映射写错会导致面板把业务冲突报成服务器错误。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AppError,
  CODES,
  httpStatusOf,
  exitCodeOf,
  toErrorPayload,
  badInput,
  notFound,
  conflict,
  blocked,
  external,
} from '../../src/core/errors.js';
import { assertSafeName, assertSafeRelPath } from '../../src/core/paths.js';

test('code -> HTTP 状态映射', () => {
  assert.equal(httpStatusOf(CODES.INVALID_INPUT), 400);
  assert.equal(httpStatusOf(CODES.NOT_FOUND), 404);
  assert.equal(httpStatusOf(CODES.CONFLICT), 409);
  assert.equal(httpStatusOf(CODES.BLOCKED), 409);
  assert.equal(httpStatusOf(CODES.EXTERNAL), 502);
  assert.equal(httpStatusOf(CODES.INTERNAL), 500);
  assert.equal(httpStatusOf('UNKNOWN_CODE'), 500, '未知 code 兜底为 500');
});

test('所有失败退出码统一为 1（agent 只区分成功/失败）', () => {
  for (const c of Object.values(CODES)) assert.equal(exitCodeOf(c), 1);
});

test('快捷构造器带上对应 code', () => {
  assert.equal(badInput('x').code, CODES.INVALID_INPUT);
  assert.equal(notFound('x').code, CODES.NOT_FOUND);
  assert.equal(conflict('x').code, CODES.CONFLICT);
  assert.equal(blocked('x').code, CODES.BLOCKED);
  assert.equal(external('x').code, CODES.EXTERNAL);
});

test('AppError 保留 message 原文（agent 靠子串分类失败）', () => {
  // assets/repo-hub/references/agent-workflow.md 教 agent 用「用法:」「未设置」
  // 「不存在」三个子串判断失败类型，message 不得被包装或截断。
  const e = notFound('repo 不存在: abc');
  assert.equal(e.message, 'repo 不存在: abc');
  assert.ok(e.message.includes('不存在'));
});

test('未知 code 构造时兜底为 INTERNAL', () => {
  assert.equal(new AppError('NOPE', 'm').code, CODES.INTERNAL);
});

test('toErrorPayload：AppError 原样透出，含 details', () => {
  const p = toErrorPayload(conflict('冲突', { files: ['a.md'] }));
  assert.deepEqual(p, { code: CODES.CONFLICT, message: '冲突', details: { files: ['a.md'] } });
});

test('toErrorPayload：普通 Error 归为 INTERNAL 且不泄漏堆栈', () => {
  const p = toErrorPayload(new Error('boom'));
  assert.deepEqual(p, { code: CODES.INTERNAL, message: 'boom' });
  assert.equal(p.stack, undefined);
});

test('assertSafeName 拒绝路径穿越，保留原文案，放行中文名', () => {
  assert.throws(() => assertSafeName('../evil'), /非法 skill 名称/);
  assert.throws(() => assertSafeName('a/b'), /非法 skill 名称/);
  assert.throws(() => assertSafeName('a\\b'), /非法 skill 名称/);
  assert.throws(() => assertSafeName('.hidden'), /非法 skill 名称/);
  assert.throws(() => assertSafeName(''), /非法 skill 名称/);
  assert.equal(assertSafeName('中文-skill'), '中文-skill');
});

test('assertSafeName 拒绝前导点：名称会变成目录，不该产出隐藏目录', () => {
  assert.throws(() => assertSafeName('.gitignore'), /非法 skill 名称/);
});

test('assertSafeRelPath 允许前导点与子目录（.gitignore / .github/workflows/x.yml）', () => {
  // 这是与 assertSafeName 刻意保留的差别：文件路径不能用目录名的规则去卡，
  // 否则 skill 里的 .gitignore 会被 apply/conflict 挡在门外。
  assert.equal(assertSafeRelPath('.gitignore'), '.gitignore');
  assert.equal(assertSafeRelPath('.github/workflows/ci.yml'), '.github/workflows/ci.yml');
  assert.equal(assertSafeRelPath('src/a/b.js'), 'src/a/b.js');
});

test('assertSafeRelPath 归一化 ./ 与重复分隔符（git 自己接受这些写法）', () => {
  assert.equal(assertSafeRelPath('./a.txt'), 'a.txt');
  assert.equal(assertSafeRelPath('a//b.txt'), 'a/b.txt');
  assert.equal(assertSafeRelPath('sub/./b.txt'), 'sub/b.txt');
});

test('assertSafeRelPath 拒绝绝对路径与 ..', () => {
  assert.throws(() => assertSafeRelPath('../x'), /不得包含 \.\./);
  assert.throws(() => assertSafeRelPath('a/../../x'), /不得包含 \.\./);
  assert.throws(() => assertSafeRelPath('/etc/passwd'), /必须是相对路径/);
  assert.throws(() => assertSafeRelPath('C:/Windows/system32'), /必须是相对路径/);
  assert.throws(() => assertSafeRelPath(''), /不能为空/);
  assert.throws(() => assertSafeRelPath('./'), /非法/);
});

test('assertSafeRelPath allowSubdir:false 时只允许单层', () => {
  assert.equal(assertSafeRelPath('.gitignore', { allowSubdir: false }), '.gitignore');
  assert.throws(() => assertSafeRelPath('sub/a.md', { allowSubdir: false }), /不能包含路径分隔符/);
});
