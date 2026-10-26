// loop-5 第 3 轮行为回归：深层目录发现 / plugin 清单 / skill hub refresh /
// updateRemote 改名重定位与 --prune。全程不碰外网。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'nxrh-r3-'));
const home = join(tmp, 'home');
mkdirSync(home, { recursive: true });
process.env.NX_RH_STORE = join(tmp, 'store.json');
process.env.NX_RH_REMOTE_DIR = join(tmp, 'staging');
process.env.NX_RH_REMOTE_REPO_DIR = join(tmp, 'remote-repo');
process.env.HOME = home;
process.env.USERPROFILE = home;

const svc = await import('../../src/modules/skills/service.js');

function putSkill(root, name, desc) {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n`);
}

after(() => rmSync(tmp, { recursive: true, force: true }));

test('深层类目布局：skills/<类目>/<name>/SKILL.md 能被订阅', async () => {
  const src = join(tmp, 'categorized');
  putSkill(join(src, 'skills', 'frontend'), 'cat-a', '两层类目');
  putSkill(join(src, 'skills', 'frontend', 'nested'), 'cat-b', '三层类目');
  putSkill(join(src, 'skills'), 'flat-a', '一级');
  const scan = await import('../../src/modules/skills/svc/scan.js');
  const skills = await scan.scanSkillsRoot(await scan.resolveSkillsRoot(src), { realOnly: true });
  const names = skills.map((s) => s.name).sort();
  assert.deepEqual(names, ['cat-a', 'cat-b', 'flat-a'], '一/二/三层都发现');
});

test('浅层遮蔽：一级是 skill 就不再深入它的子树', async () => {
  const src = join(tmp, 'shadow');
  putSkill(src, 'outer', '一级 skill');
  // 藏在 skill 目录里面的东西不算（遇 SKILL.md 即停）
  mkdirSync(join(src, 'outer', 'inner'), { recursive: true });
  writeFileSync(join(src, 'outer', 'inner', 'SKILL.md'), '---\nname: inner-inner\ndescription: 藏起来的\n---\n\n# x\n');
  const scan = await import('../../src/modules/skills/svc/scan.js');
  const skills = await scan.scanSkillsRoot(await scan.resolveSkillsRoot(src), { realOnly: true });
  const names = skills.map((s) => s.name);
  assert.ok(names.includes('outer'));
  assert.ok(!names.includes('inner-inner'), '遇 skill 即停');
});

test('plugin 清单：marketplace.json 声明的任意深度路径可发现', async () => {
  const src = join(tmp, 'marketplace');
  mkdirSync(join(src, '.claude-plugin'), { recursive: true });
  putSkill(join(src, 'docs', 'deep'), 'doc-skill', '清单声明');
  writeFileSync(
    join(src, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      metadata: { pluginRoot: '.' },
      plugins: [{ name: 'docs', source: 'docs', skills: ['./docs/deep/doc-skill'] }],
    })
  );
  const scan = await import('../../src/modules/skills/svc/scan.js');
  const { skills } = { skills: await scan.scanSkillsRoot(await scan.resolveSkillsRoot(src), { realOnly: true }) };
  assert.ok(skills.some((s) => s.name === 'doc-skill'), '清单路径被发现');
});

test('skill hub refresh：+新增 / -移除 / ~变更 三类全报，快照刷新', async () => {
  const src = join(tmp, 'refresh-src');
  putSkill(src, 'r-one', 'v1');
  putSkill(src, 'r-two', 'v1');
  await svc.addSource(src);

  const first = await svc.refreshSources(src);
  assert.equal(first.results[0].firstTime, true, '首次只建基准');

  // 上游变化：改 r-one、删 r-two、加 r-three
  writeFileSync(join(src, 'r-one', 'SKILL.md'), '---\nname: r-one\ndescription: v2\n---\n\n# v2\n');
  rmSync(join(src, 'r-two'), { recursive: true, force: true });
  putSkill(src, 'r-three', '新增');
  const second = await svc.refreshSources(src);
  const r = second.results[0];
  assert.equal(r.clean, false);
  assert.deepEqual(r.changed, ['r-one']);
  assert.deepEqual(r.removed, ['r-two']);
  assert.deepEqual(r.added, ['r-three']);
});

test('refresh 第三次：无变化 → clean', async () => {
  const src = join(tmp, 'refresh-src');
  const third = await svc.refreshSources(src);
  assert.equal(third.results[0].clean, true, '快照已刷新，第二次对比是 clean');
});

test('updateRemote 重定位：上游改 frontmatter name（目录没变）→ 按原目录找到并更新', async () => {
  // 造上游：目录 fixed-dir，frontmatter name 原为 alpha
  const fixture = join(tmp, 'reloc-upstream');
  mkdirSync(join(fixture, 'fixed-dir'), { recursive: true });
  writeFileSync(join(fixture, 'fixed-dir', 'SKILL.md'), '---\nname: alpha\ndescription: v1\n---\n\n# alpha\n');
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'init', '--quiet'], { cwd: fixture });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'], { cwd: fixture });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'v1'], { cwd: fixture });
  const spec = 'file:///' + fixture.replace(/\\/g, '/');
  await svc.importToRemote(spec);
  assert.ok((await svc.remoteContents()).skills.some((s) => s.name === 'alpha'));

  // 上游把 name 改成 beta（目录 fixed-dir 没动），内容也变
  writeFileSync(join(fixture, 'fixed-dir', 'SKILL.md'), '---\nname: beta\ndescription: v2 renamed\n---\n\n# beta\n');
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'], { cwd: fixture });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'rename frontmatter'], { cwd: fixture });

  const r = await svc.updateRemote([]);
  const alpha = r.results.find((x) => x.name === 'alpha');
  assert.equal(alpha?.status, 'updated', JSON.stringify(r.results));
  assert.equal(alpha?.relocated, true, '标出走了重定位');
  const a = (await svc.remoteContents()).skills.find((s) => s.name === 'alpha');
  assert.equal(a.description, 'v2 renamed', '磁盘内容换新（本地名保持 alpha）');
});

test('updateRemote --prune：上游真删了 → 实体与台账一起清', async () => {
  const fixture = join(tmp, 'prune-upstream');
  mkdirSync(join(fixture, 'skills', 'gone'), { recursive: true });
  writeFileSync(join(fixture, 'skills', 'gone', 'SKILL.md'), '---\nname: gone\ndescription: v1\n---\n\n# g\n');
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'init', '--quiet'], { cwd: fixture });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'], { cwd: fixture });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'v1'], { cwd: fixture });
  const spec = 'file:///' + fixture.replace(/\\/g, '/');
  await svc.importToRemote(spec);
  rmSync(join(fixture, 'skills', 'gone'), { recursive: true, force: true });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'], { cwd: fixture });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'delete'], { cwd: fixture });

  const withoutPrune = await svc.updateRemote([]);
  assert.equal(withoutPrune.results.find((x) => x.name === 'gone')?.status, 'removed');
  assert.ok((await svc.remoteContents()).skills.some((s) => s.name === 'gone'), '不带 --prune 实体还在');

  const withPrune = await svc.updateRemote([], { prune: true });
  assert.equal(withPrune.results.find((x) => x.name === 'gone')?.pruned, true);
  assert.ok(!(await svc.remoteContents()).skills.some((s) => s.name === 'gone'), '--prune 后实体与台账都没了');
});
