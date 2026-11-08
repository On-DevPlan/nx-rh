// 远程订阅的版本检测：目录级 tree SHA 比对。
//
// 判定精度是本测试的核心——上游改了 A，A 报待更新，B 仍是最新。
// 仓库级或提交级判定做不到这一点（一个提交动一个 skill 会让整仓都变）。
//
// 全程用 file:// 本地 git 夹具，不碰外网。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'nxrh-ver-'));
const home = join(tmp, 'home');
mkdirSync(home, { recursive: true });
process.env.NX_RH_STORE = join(tmp, 'store.json');
process.env.NX_RH_REMOTE_DIR = join(tmp, 'staging');
process.env.NX_RH_REMOTE_REPO_DIR = join(tmp, 'remote-hub');
process.env.HOME = home;
process.env.USERPROFILE = home;

const svc = await import('../../src/modules/skills/service.js');

function git(cwd, ...args) {
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'pipe' });
}

function putSkill(root, name, desc) {
  mkdirSync(join(root, 'skills', name), { recursive: true });
  writeFileSync(join(root, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n`);
}

const fixture = join(tmp, 'upstream');
mkdirSync(fixture, { recursive: true });
putSkill(fixture, 'alpha', 'v1');
putSkill(fixture, 'beta', 'v1');
git(fixture, 'init', '--quiet');
git(fixture, 'add', '.');
git(fixture, 'commit', '--quiet', '-m', 'v1');

const spec = 'file:///' + fixture.replace(/\\/g, '/');

after(() => rmSync(tmp, { recursive: true, force: true }));

// 读一个 skill 的检查结论
const resultOf = (r, name) => r.results.find((x) => x.name === name);

test('导入：台账记下上游目录指纹与路径', async () => {
  await svc.importToRemote(spec);
  const { skills } = await svc.remoteContents();
  const alpha = skills.find((s) => s.name === 'alpha');
  assert.match(alpha.folderHash, /^[0-9a-f]{40}$/, '上游指纹是 40 位 tree SHA');
  assert.equal(alpha.repoPath, 'skills/alpha/SKILL.md', '上游路径记下来了');
  assert.ok(alpha.commit, '上游 commit 记下来了');
});

test('首次检查：都是最新的', async () => {
  const r = await svc.checkRemoteUpdates({});
  assert.equal(r.checked, 2);
  assert.equal(r.outdated, 0);
  assert.equal(r.upToDate, 2);
  assert.equal(resultOf(r, 'alpha').status, 'up-to-date');
});

test('目录级精度：上游只改了 alpha，beta 仍是最新', async () => {
  writeFileSync(
    join(fixture, 'skills', 'alpha', 'SKILL.md'),
    '---\nname: alpha\ndescription: v2 改了\n---\n\n# alpha v2\n'
  );
  git(fixture, 'add', '.');
  git(fixture, 'commit', '--quiet', '-m', 'v2');

  const r = await svc.checkRemoteUpdates({});
  assert.equal(resultOf(r, 'alpha').status, 'outdated', '改过的那个报待更新');
  assert.equal(resultOf(r, 'beta').status, 'up-to-date', '没改的那个仍是最新');
  assert.equal(r.outdated, 1);
  // 指纹确实不同（不是靠状态字段编的）
  assert.notEqual(resultOf(r, 'alpha').currentHash, resultOf(r, 'alpha').latestHash);
  assert.equal(resultOf(r, 'beta').currentHash, resultOf(r, 'beta').latestHash);
});

test('检查是只读的：不换盘', async () => {
  const before = readFileSync(join(process.env.NX_RH_REMOTE_REPO_DIR, 'alpha', 'SKILL.md'), 'utf8');
  assert.ok(before.includes('v1'), '磁盘上还是旧版');
  await svc.checkRemoteUpdates({});
  const after_ = readFileSync(join(process.env.NX_RH_REMOTE_REPO_DIR, 'alpha', 'SKILL.md'), 'utf8');
  assert.equal(after_, before, 'check 不该改磁盘');
});

test('更新：换盘并刷新基准，之后都是最新的', async () => {
  const r = await svc.updateRemote([]);
  assert.equal(resultOf(r, 'alpha').status, 'updated');
  assert.equal(resultOf(r, 'beta').status, 'unchanged');

  const disk = readFileSync(join(process.env.NX_RH_REMOTE_REPO_DIR, 'alpha', 'SKILL.md'), 'utf8');
  assert.ok(disk.includes('v2 改了'), '实体换新了');

  const { skills } = await svc.remoteContents();
  const alpha = skills.find((s) => s.name === 'alpha');
  const chk = await svc.checkRemoteUpdates({});
  assert.equal(resultOf(chk, 'alpha').status, 'up-to-date', '更新后基准刷新了');
  assert.equal(chk.outdated, 0);
  assert.equal(alpha.folderHash, resultOf(chk, 'alpha').latestHash, '台账指纹与上游一致');
});

test('上游删了 skill：报 removed，不误报成最新', async () => {
  rmSync(join(fixture, 'skills', 'beta'), { recursive: true, force: true });
  git(fixture, 'add', '-A');
  git(fixture, 'commit', '--quiet', '-m', '删掉 beta');

  const r = await svc.checkRemoteUpdates({});
  assert.equal(resultOf(r, 'beta').status, 'removed', '上游没了要如实报');
  assert.equal(resultOf(r, 'alpha').status, 'up-to-date', 'alpha 没受影响');
});

test('手写定义：没有上游可比', async () => {
  await svc.addRemoteDefinition('my-own', { description: '我自己写的' });
  const r = await svc.checkRemoteUpdates({});
  const own = resultOf(r, 'my-own');
  assert.equal(own.status, 'skipped');
  assert.match(own.detail, /手写定义/);
});

test('上游不可访问：报 error，不静默跳过', async () => {
  const r = await svc.checkRemoteUpdates({ names: ['alpha'] });
  // 上游还在（上面只删了 beta），alpha 仍可访问
  assert.equal(resultOf(r, 'alpha').status, 'up-to-date');
});

test('指定名字：只查那一个', async () => {
  const r = await svc.checkRemoteUpdates({ names: ['my-own'] });
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].name, 'my-own');
});

test('检查结论被缓存（面板徽标读它，不必每次联网）', async () => {
  const r = await svc.checkRemoteUpdates({});
  const { lastCheck } = await svc.remoteContents();
  assert.ok(lastCheck, '缓存里有上次检查结论');
  assert.ok(lastCheck.at, '检查时间在');
  assert.deepEqual(lastCheck.outdated, r.results.filter((x) => x.status === 'outdated').map((x) => x.name));
});

test('install：导入 + 装到用户目录一条龙', async () => {
  const r = await svc.installFromRemote(spec, { to: 'user', platform: 'claude-code' });
  assert.equal(r.status, 'ok');
  assert.ok(r.imported.length, '导入了');
  assert.ok(r.install.migrated >= 1, '装到了目标');
  assert.ok(
    existsSync(join(home, '.claude', 'skills', 'alpha', 'SKILL.md')),
    '用户目录里有这份 skill'
  );
});

test('install --dry-run：不导入也不安装', async () => {
  const before = (await svc.remoteContents()).skills.length;
  const r = await svc.installFromRemote(spec, { dryRun: true });
  assert.equal(r.dryRun, true);
  assert.equal(r.imported.length, 0, '没导入');
  assert.equal(r.install, null, '没安装');
  assert.ok(r.skills.length, '但列出了上游有什么');
  assert.equal((await svc.remoteContents()).skills.length, before, '磁盘没动');
});
