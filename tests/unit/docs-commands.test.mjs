// 文档漂移防护：assets/repo-hub/ 里出现的每条 `nx-rh <子命令>` 都必须真实存在。
//
// 为什么值得一条测试：这份文档会随 npm 包装到用户机器上，直接指导 agent 敲命令。
// 命令改名或删除后文档没跟上，agent 就会照着敲一条不存在的命令——
// 而它拿到的失败信息只有「未知命令」，无从推断正确写法。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveCommand } from '../../src/runtime/cli.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOC_DIR = join(ROOT, 'assets', 'repo-hub');

function docFiles() {
  const out = [];
  for (const e of readdirSync(DOC_DIR, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith('.md')) out.push(join(DOC_DIR, e.name));
    if (e.isDirectory()) {
      for (const f of readdirSync(join(DOC_DIR, e.name))) {
        if (f.endsWith('.md')) out.push(join(DOC_DIR, e.name, f));
      }
    }
  }
  return out;
}

// 抽出 `nx-rh` 之后连续的小写命令词（跳过 <占位符> / --flag / ${变量}）
function extractCommands(text) {
  const found = new Set();
  for (const m of text.matchAll(/nx-rh\s+((?:[a-z][a-z0-9-]*)(?:\s+[a-z][a-z0-9-]*)*)/g)) {
    const tokens = m[1].split(/\s+/);
    // 取能解析成功的最长前缀；全都不行就是问题
    found.add(tokens.join(' '));
  }
  return [...found];
}

test('repo-hub 文档里的每条命令都能被解析', () => {
  const problems = [];
  let checked = 0;

  for (const file of docFiles()) {
    const text = readFileSync(file, 'utf8');
    for (const raw of extractCommands(text)) {
      const tokens = raw.split(' ');
      let hit = null;
      for (let n = tokens.length; n >= 1; n--) {
        if (resolveCommand(tokens.slice(0, n))) { hit = tokens.slice(0, n); break; }
      }
      checked++;
      if (!hit) {
        problems.push(`${file.replace(ROOT, '').replace(/\\/g, '/')} → nx-rh ${raw}`);
      }
    }
  }

  assert.ok(checked > 20, `抽到的命令太少（${checked}），抽取逻辑可能失效了`);
  assert.deepEqual(problems, [], `文档里的这些命令解析不到:\n${problems.join('\n')}`);
});

test('文档提到的每个 CLI flag 都在对应 action 里声明过', async () => {
  // 未知 flag 会被 CLI 直接拒绝（防拼写错误），所以文档写错 flag 同样会误导 agent。
  const { ACTIONS } = await import(
    pathToFileURL(join(ROOT, 'src', 'runtime', 'registry.js')).href
  );
  const { flagSpecsOf } = await import(
    pathToFileURL(join(ROOT, 'src', 'runtime', 'spec.js')).href
  );

  const known = new Set();
  for (const a of ACTIONS) for (const f of flagSpecsOf(a)) known.add(f.name);
  for (const g of ['json', 'store']) known.add(g);

  // 只说「文档提到就应该存在」——反过来（存在但没写进文档）不强制。
  // 抽取范围必须限定在 nx-rh 调用内：文档里还出现了 git 自己的 flag
  // （如 `git checkout --ours`、`git pull --no-edit`），那些不属于本次校验。
  const mentioned = new Set();
  for (const file of docFiles()) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/nx-rh\s+([^\n`]*)/g)) {
      // 剥掉行尾注释：文档里会用它解释内部实现
      // （如 `nx-rh repo pull <id>   # fetch + pull --no-edit` 中的 git 参数）
      const seg = m[1].split('#')[0];
      for (const f of seg.matchAll(/--([a-zA-Z][a-zA-Z0-9-]*)/g)) mentioned.add(f[1]);
    }
  }

  const unknown = [...mentioned].filter((f) => !known.has(f));
  assert.deepEqual(unknown, [], `文档提到但未在任何 action 里声明的 flag: ${unknown}`);
});
