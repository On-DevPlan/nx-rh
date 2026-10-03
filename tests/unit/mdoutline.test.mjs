// mdOutline / mdStats：前 N 级标题抽取 + 规模统计（纯函数）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mdOutline, mdStats } from '../../src/core/mdoutline.js';

const doc = [
  '# 总标题',
  '',
  '正文段落里的 # 不是标题',
  '',
  '## 安装',
  '```bash',
  '## 这行在代码围栏里，不是标题',
  '```',
  '### 前置要求',
  '~~~md',
  '### 围栏里的另一段',
  '~~~',
  '## 使用',
  '#### 四级标题（超出 maxLevel）',
  '收尾',
].join('\n');

test('抽取 1-3 级标题并记录行号', () => {
  const o = mdOutline(doc, 3);
  assert.deepEqual(
    o.map((h) => [h.level, h.text]),
    [[1, '总标题'], [2, '安装'], [3, '前置要求'], [2, '使用']]
  );
  assert.equal(o[0].line, 1);
  assert.equal(o[1].line, 5);
  assert.equal(o[2].line, 9);
  assert.equal(o[3].line, 13);
});

test('代码围栏里的 # 不算标题（含 ~~~ 围栏）', () => {
  const texts = mdOutline(doc, 6).map((h) => h.text);
  assert.equal(texts.includes('这行在代码围栏里，不是标题'), false);
  assert.equal(texts.includes('围栏里的另一段'), false);
});

test('maxLevel 过滤', () => {
  const all = mdOutline(doc, 6);
  assert.equal(all.some((h) => h.level === 4), true);
  assert.equal(mdOutline(doc, 3).some((h) => h.level === 4), false);
});

test('行内 # 与闭合 #* 处理', () => {
  const o = mdOutline('## 标题带闭合 ##\n', 3);
  assert.deepEqual(o, [{ level: 2, text: '标题带闭合', line: 1 }]);
  assert.deepEqual(mdOutline('普通文字 # 不是标题\n', 3), []);
});

test('空输入', () => {
  assert.deepEqual(mdOutline(''), []);
  assert.deepEqual(mdOutline(null, 3), []);
});

test('mdStats 统计行数 / 字节 / 节数', () => {
  const o = mdOutline(doc, 3);
  const s = mdStats(doc, o);
  assert.equal(s.lines, doc.split('\n').length);
  assert.equal(s.bytes, Buffer.byteLength(doc, 'utf8'));
  assert.equal(s.sections, 4);
  assert.deepEqual(mdStats('', []), { lines: 0, bytes: 0, sections: 0 });
});
