// core/diff.js 是纯函数，历史上却只被端到端冒烟间接覆盖——
// 出问题时定位成本高。这里直接打边界。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffOps, diffLines, unifiedDiff, merge3 } from '../../src/core/diff.js';

test('diffOps 逐行对齐，行号两侧独立', () => {
  const ops = diffOps('a\nb\nc\n', 'a\nx\nc\n');
  assert.deepEqual(
    ops.map((o) => [o.t, o.text]),
    [['=', 'a'], ['-', 'b'], ['+', 'x'], ['=', 'c'], ['=', '']]
  );
});

test('diffLines 只保留类型与文本', () => {
  const lines = diffLines('a\n', 'b\n');
  assert.ok(lines.every((l) => Object.keys(l).sort().join() === 't,text'));
});

test('unifiedDiff 生成 @@ 头与 +/- 行', () => {
  const out = unifiedDiff('a\nb\n', 'a\nc\n', 'old', 'new');
  assert.ok(out.startsWith('--- old\n+++ new'));
  assert.match(out, /@@ -\d+,\d+ \+\d+,\d+ @@/);
  assert.ok(out.includes('- b'));
  assert.ok(out.includes('+ c'));
});

test('merge3：两侧改不同区域 -> 自动合并，无冲突', () => {
  const r = merge3('l1\nl2\nl3\n', 'l1\nl2-a\nl3\n', 'l1\nl2\nl3-b\n');
  assert.equal(r.conflicts.length, 0);
  assert.ok(r.merged.includes('l2-a'));
  assert.ok(r.merged.includes('l3-b'));
});

test('merge3：两侧改同一行且不同 -> 冲突标记', () => {
  const r = merge3('l1\nl2\nl3\n', 'l1\nl2-a\nl3\n', 'l1\nl2-b\nl3\n');
  assert.equal(r.conflicts.length, 1);
  assert.ok(r.merged.includes('<<<<<<< ours'));
  assert.ok(r.merged.includes('======='));
  assert.ok(r.merged.includes('>>>>>>> theirs'));
});

test('merge3：两侧改成同一结果 -> 取其一，不算冲突', () => {
  const r = merge3('x\n', 'same\n', 'same\n');
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.merged, 'same\n');
});

test('merge3：仅一侧改动 -> 采用该侧', () => {
  const r = merge3('a\nb\n', 'a\nB\n', 'a\nb\n');
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.merged, 'a\nB\n');
});

test('merge3：相邻但不重叠的改动不合并成一个冲突单元', () => {
  // 这是 hunk 聚类用半开区间 [start,end) 的原因——
  // 若用闭区间，相邻改动会被并进同一个决策单元，两侧的非冲突改动就无法自动合入。
  const base = '1\n2\n3\n';
  const a = '1\nTWO\n3\n';        // 改第 2 行
  const b = '1\n2\nTHREE\n';      // 改第 3 行（相邻行）
  const r = merge3(base, a, b);
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.merged, '1\nTWO\nTHREE\n');
});

test('merge3：自定义冲突标签', () => {
  const r = merge3('x\n', 'a\n', 'b\n', { a: 'central', b: 'project' });
  assert.ok(r.merged.includes('<<<<<<< central'));
  assert.ok(r.merged.includes('>>>>>>> project'));
});

test('diffOps 空输入不抛错', () => {
  assert.deepEqual(diffOps('', '').map((o) => o.t), ['=']);
  assert.equal(diffOps(null, null).length, 1);
});
