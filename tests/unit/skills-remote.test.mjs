// 远程订阅源端到端：git clone 走 file:// 本地夹具（不碰外网），
// 下载走本进程内起的 http 服务（tar.gz 归档 + 单个 SKILL.md 两种）。
// 断言三件事：落地在 NX_RH_REMOTE_DIR、注册为普通订阅源、既有本地流程
// （listSources / listAllSourceSkills）无需任何改动就能读到它。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const tmp = mkdtempSync(join(tmpdir(), 'nxrh-remote-'));
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

// ---- 夹具 1：git 仓库（file:// 被 parseSource 认成 git 源） ----
const fixture = join(tmp, 'fixture-repo');
mkdirSync(fixture, { recursive: true });
putSkill(fixture, 'fixture-skill', 'from git fixture');
writeFileSync(join(fixture, 'README.md'), '# fixture\n');
git(fixture, 'init', '--quiet');
git(fixture, 'add', '.');
git(fixture, 'commit', '--quiet', '-m', 'init');

// ---- 夹具 2：http 服务（tar.gz 归档 + 单 SKILL.md） ----
// tar 内容带一层 repo-abc/ 外壳，验证 stripCommonRoot
function tarBytes() {
  const parts = [];
  const entry = (name, content) => {
    const data = Buffer.from(content);
    const h = Buffer.alloc(512);
    h.write(name, 0, 'utf8');
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('0', 156);
    h.write('ustar\0', 257, 'latin1');
    h.write('00', 263, 'latin1');
    h.fill(32, 148, 156);
    h.write(h.reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
    parts.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  };
  entry('repo-abc/skills/arc-skill/SKILL.md', '---\nname: arc-skill\ndescription: from archive\n---\n\n# arc\n');
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

const server = http.createServer((req, res) => {
  if (req.url === '/bundle.tar.gz') {
    const body = tarBytes();
    res.writeHead(200, { 'content-type': 'application/gzip' });
    res.end(body);
    return;
  }
  if (req.url === '/single.md') {
    res.writeHead(200, { 'content-type': 'text/markdown' });
    res.end('---\nname: single-skill\ndescription: single file\n---\n\n# single\n');
    return;
  }
  res.writeHead(404);
  res.end('nope');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

after(() => {
  server.close();
  rmSync(tmp, { recursive: true, force: true });
});

test('git 源（file://）：clone → 落地 → 注册 → 本地流程可读', async () => {
  const r = await svc.subscribeRemote('file:///' + fixture.replace(/\\/g, '/'));
  assert.equal(r.remote, true);
  assert.equal(r.count, 1);
  assert.ok(r.dir.startsWith(process.env.NX_RH_REMOTE_DIR));
  assert.ok(existsSync(join(r.dir, 'skills', 'fixture-skill', 'SKILL.md')));

  const { sources } = await svc.listSources();
  const hit = sources.find((s) => s.path === r.dir);
  assert.ok(hit, '注册进了订阅源清单');
  assert.equal(hit.remote.spec.startsWith('file://'), true);
  assert.equal(hit.count, 1);

  const pool = await svc.listAllSourceSkills();
  assert.ok(pool.some((s) => s.name === 'fixture-skill'), 'skill 池里能读到');
});

test('重复订阅同一源 = 原地刷新，不产生第二个源', async () => {
  const again = await svc.subscribeRemote('file:///' + fixture.replace(/\\/g, '/'));
  const { sources } = await svc.listSources();
  const hits = sources.filter((s) => s.path === again.dir);
  assert.equal(hits.length, 1);
});

test('归档 URL：下载 → 解包 → 剥外壳 → 注册', async () => {
  const r = await svc.subscribeRemote(`http://127.0.0.1:${port}/bundle.tar.gz`);
  assert.equal(r.count, 1);
  assert.ok(existsSync(join(r.dir, 'skills', 'arc-skill', 'SKILL.md')));
  const pool = await svc.listAllSourceSkills();
  assert.ok(pool.some((s) => s.name === 'arc-skill'));
});

test('单个 SKILL.md URL：按 frontmatter name 建目录', async () => {
  const r = await svc.subscribeRemote(`http://127.0.0.1:${port}/single.md`);
  const content = readFileSync(join(r.dir, 'single-skill', 'SKILL.md'), 'utf8');
  assert.ok(content.includes('name: single-skill'));
});

test('404 下载 → EXTERNAL 失败，不留半截目录', async () => {
  await assert.rejects(
    () => svc.subscribeRemote(`http://127.0.0.1:${port}/nope.zip`),
    (err) => err.code === 'EXTERNAL'
  );
  const { sources } = await svc.listSources();
  assert.ok(!sources.some((s) => (s.remote && s.remote.spec || '').includes('/nope.zip')));
});

test('取消订阅清掉远程元数据，磁盘保留', async () => {
  const before = await svc.listSources();
  const target = before.sources.find((s) => s.remote && s.remote.spec.includes('single.md'));
  assert.ok(target);
  await svc.removeSource(target.path);
  const after = await svc.listSources();
  assert.ok(!after.sources.some((s) => s.path === target.path));
  assert.ok(existsSync(target.path), '磁盘不动');
});

test('本地路径交给 subscribeRemote 会明确报错（入口分流由 action 做）', async () => {
  await assert.rejects(() => svc.subscribeRemote(fixture), (err) => err.code === 'INVALID_INPUT');
});

test('订阅源清单：远程源恒排最后（本地源在前、登记序不变）', async () => {
  // 此刻已有一批远程源（git/归档/单文件）；再补两个本地源，后登记也要排在前面
  const localA = join(tmp, 'local-a');
  const localB = join(tmp, 'local-b');
  for (const [dir, name] of [[localA, 'la-skill'], [localB, 'lb-skill']]) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: 本地\n---\n\n# ${name}\n`);
  }
  await svc.addSource(localA);
  await svc.addSource(localB);
  const { sources } = await svc.listSources();
  const kinds = sources.map((s) => (s.remote ? 'remote' : 'local'));
  // 恒等式：一旦出现 remote，后面不许再出现 local
  const firstRemote = kinds.indexOf('remote');
  assert.ok(firstRemote >= 0, '有远程源');
  assert.ok(kinds.slice(firstRemote).every((k) => k === 'remote'), `远程源没有排最后: ${kinds}`);
  assert.equal(kinds.indexOf('local'), 0, '首个本地源在前');
});
