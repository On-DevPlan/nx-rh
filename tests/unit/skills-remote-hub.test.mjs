// 远程 Hub 回归：一个容器、逐 skill 版本元数据、导入/定义/更新/软链/移除。
// 上游用 file:// 本地 git 夹具的第二/三次提交模拟，全程不碰外网。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'nxrh-hub-'));
const home = join(tmp, 'home');
mkdirSync(home, { recursive: true });
process.env.NX_RH_STORE = join(tmp, 'store.json');
process.env.NX_RH_REMOTE_DIR = join(tmp, 'staging');
process.env.NX_RH_REMOTE_HUB_DIR = join(tmp, 'remote-hub');
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

test('导入：进唯一远程 Hub，逐 skill 记来源与版本', async () => {
  const r = await svc.importToHub(spec);
  assert.equal(r.count, 2);
  assert.deepEqual(r.imported.sort(), ['alpha', 'beta']);
  assert.ok(existsSync(join(r.dir, 'alpha', 'SKILL.md')), 'skill 实体落在 Hub 目录');

  const { skills, dir } = await svc.hubContents();
  assert.equal(skills.length, 2);
  const alpha = skills.find((s) => s.name === 'alpha');
  assert.equal(alpha.spec, spec, '来源记下来了');
  assert.ok(alpha.hash, '版本指纹在');
  assert.ok(alpha.importedAt && alpha.updatedAt, '导入与更新时间在');
  assert.equal(alpha.manual, false);
  assert.equal(dir, process.env.NX_RH_REMOTE_HUB_DIR);
});

test('Hub 作为一个订阅源登记（可 migrate 到平台）', async () => {
  const { sources } = await svc.listSources();
  const hub = sources.find((s) => s.remote);
  assert.ok(hub, '清单里认得出远程 Hub');
  assert.equal(hub.path, process.env.NX_RH_REMOTE_HUB_DIR);
  assert.equal(hub.count, 2, 'Hub 里的 skill 算进订阅源');
});

test('添加定义：手写 skill 进 Hub（无上游）', async () => {
  const r = await svc.addHubDefinition('my-own', { description: '我自己写的' });
  assert.equal(r.name, 'my-own');
  const { skills } = await svc.hubContents();
  const own = skills.find((s) => s.name === 'my-own');
  assert.equal(own.manual, true);
  assert.equal(own.spec, '');
  assert.ok(readFileSync(join(own.dir, 'SKILL.md'), 'utf8').includes('description: 我自己写的'));
});

test('更新：无变化 → unchanged', async () => {
  const r = await svc.updateHub([]);
  const alpha = r.results.find((x) => x.name === 'alpha');
  assert.equal(alpha.status, 'unchanged');
  const own = r.results.find((x) => x.name === 'my-own');
  assert.equal(own.status, 'skipped', '手写定义没有上游');
});

test('更新：上游变了 → 换实体 + 指纹更新', async () => {
  writeFileSync(join(fixture, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: v2 改了\n---\n\n# alpha v2\n');
  rmSync(join(fixture, 'skills', 'beta'), { recursive: true, force: true });
  putSkill(fixture, 'gamma', 'v2 新增');
  git(fixture, 'add', '.');
  git(fixture, 'commit', '--quiet', '-m', 'v2');

  const r = await svc.updateHub([]);
  const alpha = r.results.find((x) => x.name === 'alpha');
  assert.equal(alpha.status, 'updated');
  assert.notEqual(alpha.hash, alpha.from);
  const beta = r.results.find((x) => x.name === 'beta');
  assert.equal(beta.status, 'removed', '上游没了要报出来');

  const { skills } = await svc.hubContents();
  const a2 = skills.find((s) => s.name === 'alpha');
  assert.equal(a2.description, 'v2 改了', '磁盘内容换新');
  assert.equal(a2.hash, alpha.hash, '元数据指纹同步');
});

test('软链：Hub 里可放软链到别处的 skill', async () => {
  const elsewhere = join(tmp, 'elsewhere');
  mkdirSync(join(elsewhere, 'linked-skill'), { recursive: true });
  writeFileSync(join(elsewhere, 'linked-skill', 'SKILL.md'), '---\nname: linked-skill\ndescription: 别处的一份\n---\n\n# L\n');
  const r = await svc.linkIntoHub('linked-skill', join(elsewhere, 'linked-skill'));
  assert.ok(r.linkType);
  const { skills } = await svc.hubContents();
  const linked = skills.find((s) => s.name === 'linked-skill');
  assert.ok(linked.linkType, '清单里标出是软链');
  assert.equal(linked.manual, true, '软链没有上游，不参与版本更新');
});

test('更新不会引入上游新增的 skill（新增要显式导入）', async () => {
  const { skills } = await svc.hubContents();
  assert.ok(!skills.some((s) => s.name === 'gamma'), '上游新增的 gamma 不在 Hub（更新不擅自引入）');
});

test('移除：从 Hub 移除条目与元数据', async () => {
  const r = await svc.removeFromHub(['my-own']);
  assert.deepEqual(r.removed, ['my-own']);
  const { skills } = await svc.hubContents();
  assert.ok(!skills.some((s) => s.name === 'my-own'));
});

test('subscribe 远程规格 = 导入 Hub（不另建源）', async () => {
  const { sources } = await svc.listSources();
  const hubs = sources.filter((s) => s.remote);
  assert.equal(hubs.length, 1, '远程相关只有一个 Hub');
});
