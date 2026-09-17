// 项目级 skill 的结构完整性。
//
// `.claude/skills/server-cli-web-scaffold/` 随仓库版本控制，是一份会被 agent 直接
// 读取的产物。它有几处「必须互相对齐」的关系，人肉维护必然漂移：
//
//   - SKILL.md 里 `[[ref-name]]` 的 name 必须等于 references/ 下的文件名
//   - 每个 ref 都要在路由表里有「何时读取」，否则它是孤儿文档、永远不会被加载
//   - 每个 ref 都要有回链，否则读者不知道它归属哪个主干
//
// 这些正是 key_board_3 列出的高频错误，用断言钉住比靠人记可靠。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILL_DIR = join(ROOT, '.claude', 'skills', 'server-cli-web-scaffold');
const SKILL_NAME = 'server-cli-web-scaffold';

// 换行归一：仓库里的 .md 在 Windows 检出后是 CRLF，而下面的 frontmatter 正则按 LF 写。
// 不归一的话这条断言只在 Windows 上红——本地测试长期带一个假失败，真问题会被它掩盖。
const main = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
const refFiles = readdirSync(join(SKILL_DIR, 'references')).filter((f) => f.endsWith('.md'));
const refNames = refFiles.map((f) => f.replace(/\.md$/, ''));

const linked = [...main.matchAll(/\[\[([a-z0-9-]+)\]\]/g)]
  .map((m) => m[1])
  .filter((x) => x !== SKILL_NAME);

test('主干 frontmatter 完整', () => {
  const fm = /^---\n([\s\S]*?)\n---/.exec(main);
  assert.ok(fm, 'SKILL.md 缺少 YAML frontmatter');
  assert.match(fm[1], new RegExp(`^name:\\s*${SKILL_NAME}$`, 'm'));
  const desc = /^description:\s*(.+)$/m.exec(fm[1]);
  assert.ok(desc && desc[1].length > 30, 'description 应是触发描述且足够具体');
});

test('没有引用了但不存在的 ref', () => {
  const missing = linked.filter((n) => !refNames.includes(n));
  assert.deepEqual(missing, [], `SKILL.md 引用了不存在的 ref: ${missing}`);
});

test('没有孤儿 ref（存在但从未被引用）', () => {
  const orphan = refNames.filter((n) => !linked.includes(n));
  assert.deepEqual(orphan, [], `这些 ref 是孤儿文档，永远不会被加载: ${orphan}`);
});

test('每个 ref 都在路由表里写了「何时读取」', () => {
  const routed = [...main.matchAll(/\|\s*\[\[([a-z0-9-]+)\]\]\s*\|/g)].map((m) => m[1]);
  const missing = refNames.filter((n) => !routed.includes(n));
  assert.deepEqual(missing, [], `这些 ref 没有加载引导（什么时候读它）: ${missing}`);
});

test('每个 ref 都有回链与足够内容', () => {
  for (const f of refFiles) {
    const text = readFileSync(join(SKILL_DIR, 'references', f), 'utf8');
    assert.ok(
      text.includes(`[[${SKILL_NAME}]]`),
      `${f} 缺少指回主干的链接`
    );
    assert.ok(text.trim().length > 400, `${f} 内容过少，疑似空文档`);
  }
});

test('ref 的章节编号连续（「一 二 三 …」不跳号不重复）', () => {
  const order = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  for (const f of refFiles) {
    const text = readFileSync(join(SKILL_DIR, 'references', f), 'utf8');
    const nums = [...text.matchAll(/^## ([一二三四五六七八九十]+)、/gm)].map((m) => m[1]);
    const idx = nums.map((n) => order.indexOf(n));
    for (let i = 1; i < idx.length; i++) {
      assert.equal(
        idx[i],
        idx[i - 1] + 1,
        `${f} 章节编号不连续: ${nums.join(' ')}`
      );
    }
  }
});

test('主干保留了主流程与验收清单（不该被拆进 ref）', () => {
  assert.match(main, /## 创建流程/, '创建流程必须留在主干');
  assert.match(main, /## 验收清单/, '验收清单必须留在主干');
  assert.match(main, /## 核心不变量/, '核心不变量必须留在主干');
});
