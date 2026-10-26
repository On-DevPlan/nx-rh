// 远程订阅 回归：一个容器、逐 skill 版本元数据、导入/定义/更新/软链/移除。
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

test('导入：进唯一远程订阅，逐 skill 记来源与版本', async () => {
  const r = await svc.importToRemote(spec);
  assert.equal(r.count, 2);
  assert.deepEqual(r.imported.sort(), ['alpha', 'beta']);
  assert.ok(existsSync(join(r.dir, 'alpha', 'SKILL.md')), 'skill 实体落在 Hub 目录');

  const { skills, dir } = await svc.remoteContents();
  assert.equal(skills.length, 2);
  const alpha = skills.find((s) => s.name === 'alpha');
  assert.equal(alpha.spec, spec, '来源记下来了');
  assert.ok(alpha.hash, '版本指纹在');
  assert.ok(alpha.importedAt && alpha.updatedAt, '导入与更新时间在');
  assert.equal(alpha.manual, false);
  assert.equal(dir, process.env.NX_RH_REMOTE_REPO_DIR);
});

test('Hub 作为一个订阅源登记（可 migrate 到平台）', async () => {
  const { sources } = await svc.listSources();
  const hub = sources.find((s) => s.remote);
  assert.ok(hub, '清单里认得出远程订阅');
  assert.equal(hub.path, process.env.NX_RH_REMOTE_REPO_DIR);
  assert.equal(hub.count, 2, 'Hub 里的 skill 算进订阅源');
});

test('添加定义：手写 skill 进 Hub（无上游）', async () => {
  const r = await svc.addRemoteDefinition('my-own', { description: '我自己写的' });
  assert.equal(r.name, 'my-own');
  const { skills } = await svc.remoteContents();
  const own = skills.find((s) => s.name === 'my-own');
  assert.equal(own.manual, true);
  assert.equal(own.spec, '');
  assert.ok(readFileSync(join(own.dir, 'SKILL.md'), 'utf8').includes('description: 我自己写的'));
});

test('更新：无变化 → unchanged', async () => {
  const r = await svc.updateRemote([]);
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

  const r = await svc.updateRemote([]);
  const alpha = r.results.find((x) => x.name === 'alpha');
  assert.equal(alpha.status, 'updated');
  assert.notEqual(alpha.hash, alpha.from);
  const beta = r.results.find((x) => x.name === 'beta');
  assert.equal(beta.status, 'removed', '上游没了要报出来');

  const { skills } = await svc.remoteContents();
  const a2 = skills.find((s) => s.name === 'alpha');
  assert.equal(a2.description, 'v2 改了', '磁盘内容换新');
  assert.equal(a2.hash, alpha.hash, '元数据指纹同步');
});

test('软链：Hub 里可放软链到别处的 skill', async () => {
  const elsewhere = join(tmp, 'elsewhere');
  mkdirSync(join(elsewhere, 'linked-skill'), { recursive: true });
  writeFileSync(join(elsewhere, 'linked-skill', 'SKILL.md'), '---\nname: linked-skill\ndescription: 别处的一份\n---\n\n# L\n');
  const r = await svc.linkIntoRemote('linked-skill', join(elsewhere, 'linked-skill'));
  assert.ok(r.linkType);
  const { skills } = await svc.remoteContents();
  const linked = skills.find((s) => s.name === 'linked-skill');
  assert.ok(linked.linkType, '清单里标出是软链');
  assert.equal(linked.manual, true, '软链没有上游，不参与版本更新');
});

test('更新不会引入上游新增的 skill（新增要显式导入）', async () => {
  const { skills } = await svc.remoteContents();
  assert.ok(!skills.some((s) => s.name === 'gamma'), '上游新增的 gamma 不在 Hub（更新不擅自引入）');
});

test('移除：从 Hub 移除条目与元数据', async () => {
  const r = await svc.removeFromRemote(['my-own']);
  assert.deepEqual(r.removed, ['my-own']);
  const { skills } = await svc.remoteContents();
  assert.ok(!skills.some((s) => s.name === 'my-own'));
});

test('subscribe 远程规格 = 导入 Hub（不另建源）', async () => {
  const { sources } = await svc.listSources();
  const hubs = sources.filter((s) => s.remote);
  assert.equal(hubs.length, 1, '远程相关只有一个 Hub');
});

test('上游 name 不可信：../evil 被拒（不写到仓库外）', async () => {
  // 夹具：上游仓库里放一个 name 带路径穿越的 skill
  mkdirSync(join(fixture, 'skills', 'evil'), { recursive: true });
  writeFileSync(
    join(fixture, 'skills', 'evil', 'SKILL.md'),
    '---\nname: ../../evil\ndescription: 路径穿越\n---\n\n# evil\n'
  );
  git(fixture, 'add', '.');
  git(fixture, 'commit', '--quiet', '-m', 'evil');
  await assert.rejects(
    () => svc.importToRemote(spec),
    (err) => err.code === 'INVALID_INPUT'
  );
  // 仓库外不得出现任何文件
  assert.ok(!existsSync(join(tmp, 'evil')), '没有写到仓库目录之外');
});

test('链出：仓库里这份不动，别处建一个指向它的链接', async () => {
  const elsewhere = join(tmp, 'linked-out');
  const r = await svc.linkFromRemote('alpha', elsewhere);
  assert.equal(r.from, join(process.env.NX_RH_REMOTE_REPO_DIR, 'alpha'));
  assert.ok(existsSync(join(elsewhere, 'SKILL.md')), '别处能读到内容');
  const { skills } = await svc.remoteContents();
  const alpha = skills.find((s) => s.name === 'alpha');
  assert.ok(alpha && !alpha.linkType, '仓库里那份仍是实体');
});

test('purge 远程仓库里的 skill 后，update 不会把它复活', async () => {
  // gamma 之前被上游删了，用 alpha 试：先 purge 掉仓库里那份
  const before = (await svc.remoteContents()).skills.map((s) => s.name);
  assert.ok(before.includes('alpha'));
  await svc.purgeSkill({ name: 'alpha', force: true });
  const after = (await svc.remoteContents()).skills.map((s) => s.name);
  assert.ok(!after.includes('alpha'), '实体已删');

  // 上游还在（夹具里 alpha 仍存在）——若元数据没同步，update 会把它拉回来
  const r = await svc.updateRemote([]);
  const alpha = r.results.find((x) => x.name === 'alpha');
  assert.equal(alpha, undefined, 'update 不再管这个已 purge 的 skill');
  const again = (await svc.remoteContents()).skills.map((s) => s.name);
  assert.ok(!again.includes('alpha'), '没有复活');
});

test('import --dry-run：只列清单不拷贝（对标 add --list）', async () => {
  const before = (await svc.remoteContents()).skills.length;
  // 夹具上游 HEAD 还留着 ../../evil 那个 skill——安全校验应让整次导入被拒
  await assert.rejects(
    () => svc.importToRemote(spec, { dryRun: true }),
    (err) => err.code === 'INVALID_INPUT'
  );
  const after = (await svc.remoteContents()).skills.length;
  assert.equal(after, before, '磁盘没动');
  // 换干净的上游（evil 之前的提交，打 tag 再按 tag 拉）验证正常列出
  execFileSync('git', ['-C', fixture, 'tag', 'clean', 'HEAD~1']);
  const r = await svc.importToRemote(spec + '#clean', { dryRun: true });
  assert.equal(r.dryRun, true);
  assert.ok(r.count >= 2, '列出了上游 skill');
  assert.ok(r.skills.every((s) => s.name && s.hash), '每项带名称与版本指纹');
});

test('submit 落入远程订阅：登记台账（不再是幽灵实体）', async () => {
  // 造一个平台侧实体，submit --into 远程订阅目录
  const proj = join(tmp, 'submit-proj');
  mkdirSync(join(proj, '.claude', 'skills', 'alpha'), { recursive: true });
  writeFileSync(join(proj, '.claude', 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: 平台侧改动版\n---\n\n# alpha local\n');
  const repoDir = process.env.NX_RH_REMOTE_REPO_DIR;
  await svc.submitSkill({ name: 'alpha', to: 'project', platform: 'claude-code', project: proj, force: true, keepTarget: true, into: repoDir });
  const { skills } = await svc.remoteContents();
  const alpha = skills.find((s) => s.name === 'alpha');
  assert.ok(alpha, 'submit 后在远程订阅里');
  // 台账有这条（manual=false 之类判定不适用——spec 保留原上游），且 update 以它为基准
  const r = await svc.updateRemote(['alpha']);
  const one = r.results.find((x) => x.name === 'alpha');
  assert.ok(one && one.status !== 'error', 'update 认得出这条（不再是幽灵）');
});
