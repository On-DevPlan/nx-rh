// 远程 Hub 的下载面回归：git 源（file:// 夹具）、归档 URL、单 SKILL.md URL。
// 全程不碰外网：git 用本地夹具，HTTP 用进程内服务。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { gzipSync } from 'node:zlib';

const tmp = mkdtempSync(join(tmpdir(), 'nxrh-remote-'));
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

// ---- 夹具 1：git 仓库（file:// 被 parseSource 认成 git 源） ----
const fixture = join(tmp, 'fixture-repo');
mkdirSync(fixture, { recursive: true });
putSkill(fixture, 'fixture-skill', 'from git fixture');
writeFileSync(join(fixture, 'README.md'), '# fixture\n');
git(fixture, 'init', '--quiet');
git(fixture, 'add', '.');
git(fixture, 'commit', '--quiet', '-m', 'init');

// ---- 夹具 2：http 服务（tar.gz 归档 + 单 SKILL.md） ----
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

test('git 源（file://）：clone → 进 Hub → 清单可读', async () => {
  const r = await svc.importToHub('file:///' + fixture.replace(/\\/g, '/'));
  assert.equal(r.count, 1);
  assert.ok(existsSync(join(r.dir, 'fixture-skill', 'SKILL.md')));

  const { skills } = await svc.hubContents();
  const sk = skills.find((s) => s.name === 'fixture-skill');
  assert.ok(sk, 'Hub 清单里有它');
  assert.ok(sk.spec.startsWith('file://'), '来源记下来了');
});

test('归档 URL：下载 → 解包 → 剥外壳 → 进 Hub', async () => {
  const r = await svc.importToHub(`http://127.0.0.1:${port}/bundle.tar.gz`);
  assert.equal(r.count, 1);
  const { skills } = await svc.hubContents();
  assert.ok(skills.some((s) => s.name === 'arc-skill'));
});

test('单个 SKILL.md URL：按 frontmatter name 建目录', async () => {
  await svc.importToHub(`http://127.0.0.1:${port}/single.md`);
  const { skills } = await svc.hubContents();
  const sk = skills.find((s) => s.name === 'single-skill');
  assert.ok(sk);
  assert.ok(readFileSync(join(sk.dir, 'SKILL.md'), 'utf8').includes('name: single-skill'));
});

test('404 下载 → EXTERNAL 失败，Hub 里不留半截', async () => {
  const before = (await svc.hubContents()).skills.length;
  await assert.rejects(
    () => svc.importToHub(`http://127.0.0.1:${port}/nope.zip`),
    (err) => err.code === 'EXTERNAL'
  );
  const afterCount = (await svc.hubContents()).skills.length;
  assert.equal(afterCount, before, '失败的导入不落盘');
});
