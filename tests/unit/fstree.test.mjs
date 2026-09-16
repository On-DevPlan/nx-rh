// core/fstree.js：目录树遍历与逐文件差异。
// 这些函数从 services/skills.js 下沉而来，被 skill 同步与内置包安装共用。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exists, pathExists, md5Of, walkFiles, diffTrees } from '../../src/core/fstree.js';

function fixture(tree) {
  const root = mkdtempSync(join(tmpdir(), 'nxrh-fstree-'));
  for (const [rel, content] of Object.entries(tree)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

test('walkFiles 递归收集，rel 用正斜杠', async () => {
  const root = fixture({ 'SKILL.md': 'x', 'references/a.md': 'y' });
  const files = await walkFiles(root);
  assert.deepEqual([...files.keys()].sort(), ['SKILL.md', 'references/a.md']);
  assert.equal(files.get('SKILL.md').md5, md5Of(Buffer.from('x')));
  rmSync(root, { recursive: true, force: true });
});

test('diffTrees 三种 side 判定', async () => {
  const a = fixture({ 'same.md': 'S', 'differ.md': 'A', 'onlyA.md': 'A' });
  const b = fixture({ 'same.md': 'S', 'differ.md': 'B', 'onlyB.md': 'B' });
  const diff = await diffTrees(a, b);
  const byFile = Object.fromEntries(diff.map((d) => [d.file, d.side]));
  // 内容相同的文件不出现在结果里
  assert.deepEqual(byFile, {
    'differ.md': 'both-differ',
    'onlyA.md': 'only-central',
    'onlyB.md': 'only-project',
  });
  rmSync(a, { recursive: true, force: true });
  rmSync(b, { recursive: true, force: true });
});

test('diffTrees 对不存在的 b 侧等同空树（bundled 用它列出全部文件）', async () => {
  const a = fixture({ 'SKILL.md': 'x', 'references/a.md': 'y' });
  const diff = await diffTrees(a, join(a, '__definitely_missing__'));
  assert.equal(diff.length, 2);
  assert.ok(diff.every((d) => d.side === 'only-central'));
  rmSync(a, { recursive: true, force: true });
});

test('两侧都空 -> 无差异', async () => {
  const a = fixture({});
  const b = fixture({});
  assert.deepEqual(await diffTrees(a, b), []);
  rmSync(a, { recursive: true, force: true });
  rmSync(b, { recursive: true, force: true });
});

test('悬空链接：pathExists 必须认它存在（否则删不掉）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nxrh-fstree-'));
  const dangling = join(root, 'dangling');
  // 指向不存在的目标：语义上等同于「中心侧已删除的 skill」
  const { symlinkSync } = await import('node:fs');
  try {
    symlinkSync(join(root, 'nope'), dangling, 'junction');
  } catch {
    rmSync(root, { recursive: true, force: true });
    return; // 环境不允许建链接（权限 / 跨卷），跳过
  }

  // 这条是承重断言：项目侧链接必须能被列出来并删除
  assert.equal(await pathExists(dangling), true, '悬空链接在 pathExists 眼里存在，才能被识别删除');

  // exists 走 access()，是否穿透链接由操作系统决定——POSIX symlink 悬空为 false，
  // Windows junction 悬空为 true。这里不断言具体值，只确认它有结果，
  // 以防有人误以为 exists 也可以用来识别悬空链接。
  assert.equal(typeof (await exists(dangling)), 'boolean');

  rmSync(root, { recursive: true, force: true });
});
