// worktrees 模块单元测试：在临时 git 仓库里跑真实 worktree 生命周期。
// 本文件由 node --test 放在独立子进程运行，chdir 与 NX_RH_STORE 都只影响本文件，
// 不会写脏用户目录。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

let root;
let svc;
let coreGit;
let coreGi;

function git(args, cwd = root) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r;
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'wtunit-'));
  process.env.NX_RH_STORE = join(root, 'store.json');

  git(['init', '-b', 'main']);
  git(['config', 'user.email', 't@t.t']);
  git(['config', 'user.name', 't']);
  writeFileSync(join(root, 'README.md'), 'hello');
  git(['add', '-A']);
  git(['commit', '-m', 'init']);

  writeFileSync(join(root, '.gitignore'), '.env\nsecrets/\n*.log\n');
  // .gitignore 要像真实项目一样提交：工作树才会带着它，同步进去的被忽略文件才不会变脏
  git(['add', '.gitignore']);
  git(['commit', '-m', 'gitignore']);

  mkdirSync(join(root, 'secrets'));
  writeFileSync(join(root, '.env'), 'KEY=1\n');
  writeFileSync(join(root, 'secrets', 'a.txt'), 'secret');

  process.chdir(root);
  // 直接按绝对路径引入被测模块
  svc = await import(
    pathToFileURL('D:/a_js/js_proj/nx-rh/src/modules/worktrees/service.js').href
  );
  coreGit = await import(pathToFileURL('D:/a_js/js_proj/nx-rh/src/core/git.js').href);
  coreGi = await import(pathToFileURL('D:/a_js/js_proj/nx-rh/src/core/gitignore.js').href);
});

// ---- 纯解析 ----

test('parseWorktreePorcelain：主树 + 链接树 + 分离 HEAD', () => {
  const text = [
    'worktree /repo',
    'HEAD aaa111',
    'branch refs/heads/main',
    '',
    'worktree /repo/.wt/t1',
    'HEAD bbb222',
    'branch refs/heads/feature/t1',
    '',
    'worktree /repo/.wt/t2',
    'HEAD ccc333',
    'detached',
    '',
  ].join('\n');
  const recs = coreGit.parseWorktreePorcelain(text);
  assert.equal(recs.length, 3);
  assert.equal(recs[0].path, '/repo');
  assert.equal(recs[0].branch, 'main');
  assert.equal(recs[1].branch, 'feature/t1');
  assert.equal(recs[2].detached, true);
  assert.equal(recs[2].branch, null);
});

test('parseGitignore：取反/目录/glob/锚定分类正确', () => {
  const entries = coreGi.parseGitignore('node_modules/\n!.keep\n*.log\n/config/x.txt\n');
  assert.equal(entries[0].dirOnly, true);
  assert.equal(entries[1].negated, true);
  assert.equal(entries[2].hasGlob, true);
  assert.equal(entries[3].rootAnchored, true);
  const concrete = coreGi.concreteEntries(entries).map((e) => e.path);
  assert.deepEqual(concrete, ['node_modules', 'config/x.txt']);
});

// ---- 非 git 目录安全降级 ----

test('非 git 目录：overview 降级且不抛', async () => {
  const nonGit = mkdtempSync(join(tmpdir(), 'wtunit-nogit-'));
  const o = await svc.overview(nonGit);
  assert.equal(o.git, false);
});

// ---- 初始化（工作树根放主仓库内，验证 .gitignore 登记） ----

test('wt init：根目录在主仓库内时登记 .gitignore', async () => {
  const r = await svc.initWorktree({ worktreeRoot: join(root, '.worktrees') });
  assert.equal(r.status, 'ok');
  assert.equal(r.gitignoreAdded, '.worktrees/');
  assert.match(readFileSync(join(root, '.gitignore'), 'utf8'), /\.worktrees\//);

  // 二次 init 幂等：不再重复登记
  const r2 = await svc.initWorktree({ worktreeRoot: join(root, '.worktrees') });
  assert.equal(r2.gitignoreAdded, null);
});

// ---- 创建 / 清单 / 详情 ----

test('wt add：创建分支与工作树；重复会话名冲突', async () => {
  const r = await svc.addWorktree({ description: 'add login captcha' });
  assert.equal(r.status, 'ok');
  assert.equal(r.branch, 'feature/add-login-captcha');
  assert.match(r.path, /add-login-captcha/);

  await assert.rejects(svc.addWorktree({ description: 'x', name: 'add login captcha' }), {
    code: 'CONFLICT',
  });
});

test('wt list / get：主树标记、富状态、按名与路径匹配', async () => {
  const { worktrees } = await svc.listWorktrees();
  assert.equal(worktrees.length, 2);
  const main = worktrees.find((w) => w.isMain);
  assert.equal(main.name, 'main');
  const wt = worktrees.find((w) => !w.isMain);

  const byName = await svc.getWorktree('add-login-captcha');
  assert.equal(byName.path, wt.path);
  const byPath = await svc.getWorktree(wt.path);
  assert.equal(byPath.branch, 'feature/add-login-captcha');
  await assert.rejects(svc.getWorktree('nope'), { code: 'NOT_FOUND' });
});

test('wt checkout：已存在分支挂成工作树', async () => {
  git(['branch', 'hot1']);
  const r = await svc.checkoutWorktree({ branch: 'hot1' });
  assert.equal(r.branch, 'hot1');
  await assert.rejects(svc.checkoutWorktree({ branch: 'hot1' }), { code: 'CONFLICT' });
});

// ---- 扩展文件：发现 / 登记 / 变更检测 ----

test('wt ext discover：默认只建议，--apply 登记', async () => {
  const plan = await svc.discoverExtensions({});
  assert.equal(plan.apply, false);
  assert.ok(plan.summary.found >= 2);

  const applied = await svc.discoverExtensions({ apply: true });
  assert.ok(applied.summary.added >= 2);

  const list = await svc.listExtensions();
  const rels = list.items.map((i) => i.rel);
  assert.ok(rels.includes('.env'));
  assert.ok(rels.includes('secrets'));
});

test('登记被跟踪文件默认阻止，--force 放行', async () => {
  await assert.rejects(svc.addExtension({ abspath: join(root, 'README.md') }), {
    code: 'BLOCKED',
  });
  const r = await svc.addExtension({ abspath: join(root, 'README.md'), force: true });
  assert.equal(r.status, 'ok');
  const removed = await svc.removeExtension(r.id);
  assert.equal(removed.status, 'ok');
});

test('主项目扩展文件变更可被检出', async () => {
  writeFileSync(join(root, '.env'), 'KEY=2\n');
  const list = await svc.listExtensions();
  const env = list.items.find((i) => i.rel === '.env');
  assert.equal(env.changed, true);
});

// ---- 同步进工作树（含冲突与强制覆盖） ----

test('wt ext sync：首次复制；主项目再变更则冲突，--force 覆盖；随后跳过', async () => {
  // 首次：工作树里没有这些文件 → 复制主项目当前内容（.env 此时已是 KEY=2）
  const first = await svc.syncExtensions({ target: 'add-login-captcha' });
  assert.equal(first.status, 'ok');
  assert.ok(first.summary.copied >= 2);

  // 主项目 .env 再次变更
  writeFileSync(join(root, '.env'), 'KEY=3\n');
  const blockedSync = await svc.syncExtensions({ target: 'add-login-captcha' });
  assert.equal(blockedSync.status, 'conflict');
  assert.ok(blockedSync.summary.conflict >= 1);

  const forced = await svc.syncExtensions({ target: 'add-login-captcha', force: true });
  assert.ok(forced.summary.copied >= 1);

  const again = await svc.syncExtensions({ target: 'add-login-captcha' });
  assert.equal(again.summary.conflict, 0);
  assert.ok(again.summary.skipped >= 1);

  // 从工作树视角：.env 与主项目当前内容一致
  const inWt = await svc.listExtensions({ target: 'add-login-captcha' });
  assert.equal(inWt.isMain, false);
  assert.equal(inWt.items.find((i) => i.rel === '.env').upToDate, true);
});

test('非工作树内且无 --target：给出可分类 BLOCKED', async () => {
  await assert.rejects(svc.syncExtensions({}), { code: 'BLOCKED' });
});

// ---- rebase / fanout ----

test('wt rebase：主项目新提交后，工作树可 rebase 上去', async () => {
  writeFileSync(join(root, 'new2.txt'), '2');
  git(['add', '-A']);
  git(['commit', '-m', 'second']);

  const before = (await svc.listWorktrees()).worktrees.find(
    (w) => w.name === 'add-login-captcha'
  );
  assert.equal(before.behind, 1);

  const r = await svc.rebaseWorktree({ target: 'add-login-captcha' });
  assert.equal(r.status, 'ok');

  const after = (await svc.listWorktrees()).worktrees.find(
    (w) => w.name === 'add-login-captcha'
  );
  assert.equal(after.behind, 0);
});

test('wt fanout：先计划后执行，同步全部工作树', async () => {
  writeFileSync(join(root, 'new3.txt'), '3');
  git(['add', '-A']);
  git(['commit', '-m', 'third']);

  const plan = await svc.fanout({});
  assert.equal(plan.status, 'planned');

  const done = await svc.fanout({ yes: true });
  assert.equal(done.status, 'ok');
  assert.ok(done.completed.includes('add-login-captcha'));
});

test('脏工作树 rebase 无 --message 时 blocked', async () => {
  const wtPath = (await svc.listWorktrees()).worktrees.find(
    (w) => w.name === 'add-login-captcha'
  ).path;
  writeFileSync(join(wtPath, 'scratch.txt'), 'x');
  const r = await svc.rebaseWorktree({ target: 'add-login-captcha' });
  assert.equal(r.status, 'blocked');
});

// ---- 主项目上下文 ----

test('wt context：主项目 + 当前工作树 + 建议指令一次拿齐', async () => {
  const c = await svc.getContext();
  assert.equal(c.git, true);
  assert.equal(c.main.branch, 'main');
  assert.ok(Array.isArray(c.suggested));
  assert.ok(c.main.log.length > 0);
});

// ---- 移除 ----

test('wt remove：主树不可删；普通树可删并连分支删', async () => {
  await assert.rejects(svc.removeWorktree('main'), { code: 'BLOCKED' });

  const r = await svc.removeWorktree('hot1', { branch: true });
  assert.equal(r.status, 'ok');
  assert.equal(r.branchDeleted, true);
});
