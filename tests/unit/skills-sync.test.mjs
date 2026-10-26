// skill hub sync 回归：订阅 → 上游变化 → sync 报告并换新 → 快照刷新。
// 上游用 file:// 本地 git 夹具的第二/三次提交模拟，全程不碰外网。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'nxrh-sync-'));
const home = join(tmp, 'home');
mkdirSync(home, { recursive: true });
process.env.NX_RH_STORE = join(tmp, 'store.json');
process.env.NX_RH_REMOTE_DIR = join(tmp, 'remote-skills');
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

test('订阅即记录 skills 快照', async () => {
  const r = await svc.subscribeRemote(spec);
  assert.equal(r.count, 2);
  const metas = await svc.remoteMetaMap();
  const meta = metas[r.dir];
  assert.ok(meta, '元数据在');
  assert.ok(meta.skills && meta.skills.alpha && meta.skills.beta, '快照含各 skill 指纹');
  assert.equal(Object.keys(meta.skills).length, 2);
});

test('上游无变化：sync 报告 clean，不误报', async () => {
  const r = await svc.syncSource(spec);
  assert.equal(r.status, 'ok');
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].clean, true);
  assert.deepEqual(r.results[0].changed, []);
});

test('上游变化：+ 新增 / ~ 变更 / - 移除 全对上，磁盘换新', async () => {
  // v2：alpha 改内容、beta 删掉、gamma 新增
  writeFileSync(join(fixture, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: v2 改了\n---\n\n# alpha v2\n');
  rmSync(join(fixture, 'skills', 'beta'), { recursive: true, force: true });
  putSkill(fixture, 'gamma', 'v2 新增');
  git(fixture, 'add', '.');
  git(fixture, 'commit', '--quiet', '-m', 'v2');

  const r = await svc.syncSource(spec);
  const one = r.results[0];
  assert.equal(one.clean, false);
  assert.deepEqual(one.added, ['gamma']);
  assert.deepEqual(one.removed, ['beta']);
  assert.deepEqual(one.changed, ['alpha']);

  const pool = await svc.listAllSourceSkills();
  assert.ok(pool.some((s) => s.name === 'gamma' && s.description === 'v2 新增'));
  assert.ok(!pool.some((s) => s.name === 'beta'), '移除的 skill 从池里消失');

  const metas = await svc.remoteMetaMap();
  // syncOne 换入后 registered 路径不变（同 id 原地刷新）
  const meta = Object.values(metas).find((m) => m.spec === spec);
  assert.ok(meta.skills.gamma && !meta.skills.beta && meta.skills.alpha, '快照已刷新到 v2');
});

test('--dry-run：只对比不落盘', async () => {
  // v3：再改 alpha
  writeFileSync(join(fixture, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: v3\n---\n\n# alpha v3\n');
  git(fixture, 'add', '.');
  git(fixture, 'commit', '--quiet', '-m', 'v3');

  const r = await svc.syncSource(spec, { dryRun: true });
  assert.equal(r.results[0].dryRun, true);
  assert.deepEqual(r.results[0].changed, ['alpha']);

  // 磁盘仍是 v2（sync 前最后一次 commit 换入的）
  const metas = await svc.remoteMetaMap();
  const meta = Object.values(metas).find((m) => m.spec === spec);
  const dir = Object.keys(metas).find((k) => metas[k].spec === spec);
  assert.ok(readFileSync(join(dir, 'skills', 'alpha', 'SKILL.md'), 'utf8').includes('v2 改了'));
  assert.ok(!meta.skills.beta, '快照也没动');
});

test('点名本地源路径 → INVALID_INPUT', async () => {
  await assert.rejects(() => svc.syncSource(fixture), (err) => err.code === 'INVALID_INPUT');
});

test('没有远程源时（清空后）→ 空结果不报错', async () => {
  const metas = await svc.remoteMetaMap();
  for (const p of Object.keys(metas)) await svc.removeSource(p);
  const r = await svc.syncSource();
  assert.equal(r.status, 'ok');
  assert.equal(r.results.length, 0);
  assert.ok(r.note);
  assert.ok(!existsSync(join(tmp, 'remote-skills', 'dont-care')), 'sanity');
});
