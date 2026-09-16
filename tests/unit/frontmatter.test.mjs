// SKILL.md frontmatter 解析的边界。
// CRLF 那条是真实踩过的坑：Windows 上 SKILL.md 通常是 CRLF，
// 不先归一化换行，name/description 会全部读成空。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter } from '../../src/core/frontmatter.js';

test('LF 单行值', () => {
  const r = parseFrontmatter('---\nname: demo\ndescription: 说明\n---\n\n# 正文\n');
  assert.equal(r.name, 'demo');
  assert.equal(r.description, '说明');
});

test('CRLF 换行同样能读出字段', () => {
  const r = parseFrontmatter('---\r\nname: crlf\ndescription: 换行是 CRLF\r\n---\r\n\r\n# 正文\r\n');
  assert.equal(r.name, 'crlf');
  assert.equal(r.description, '换行是 CRLF');
});

test('带前导 BOM 也能解析', () => {
  const r = parseFrontmatter('﻿---\nname: bom\ndescription: 有 BOM\n---\n');
  assert.equal(r.name, 'bom');
  assert.equal(r.description, '有 BOM');
});

test('成对引号被剥离', () => {
  assert.equal(parseFrontmatter('---\nname: q\ndescription: "带引号"\n---\n').description, '带引号');
  assert.equal(parseFrontmatter("---\nname: q\ndescription: '单引号'\n---\n").description, '单引号');
});

test('折叠块标量 > 合并为一行', () => {
  const r = parseFrontmatter('---\nname: b\ndescription: >\n  第一行\n  第二行\n---\n');
  assert.equal(r.description, '第一行 第二行');
});

test('字面块标量 | 保留换行', () => {
  const r = parseFrontmatter('---\nname: b\ndescription: |\n  第一行\n  第二行\n---\n');
  assert.equal(r.description, '第一行\n第二行');
});

test('缺少 frontmatter 时返回空串而非抛错', () => {
  assert.deepEqual(parseFrontmatter('# 只有正文\n'), { name: '', description: '' });
  assert.deepEqual(parseFrontmatter(''), { name: '', description: '' });
  assert.deepEqual(parseFrontmatter(null), { name: '', description: '' });
});

test('只解析 name/description，其他字段忽略且不干扰', () => {
  const r = parseFrontmatter('---\ntitle: 别的\nname: real\nallowed-tools: Read\ndescription: 描述\n---\n');
  assert.equal(r.name, 'real');
  assert.equal(r.description, '描述');
});

test('字段缺失时是空串（由调用方兜底为目录名）', () => {
  const r = parseFrontmatter('---\nname: only\n---\n');
  assert.equal(r.name, 'only');
  assert.equal(r.description, '');
});
