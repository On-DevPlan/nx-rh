// 远程源规格解析的纯函数回归：parseSource 认串，remoteSourceId 推目录名。
// 只测解析，不碰网络与磁盘存储。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSource, remoteSourceId, sanitizeSubpath } from '../../src/modules/skills/svc/remote-parse.js';
import { AppError } from '../../src/core/errors.js';

test('本地路径 → local（含 Windows 盘符与相对路径）', () => {
  assert.equal(parseSource('D:\\hub').type, 'local');
  assert.equal(parseSource('D:/hub/skills').type, 'local');
  assert.equal(parseSource('./hub').type, 'local');
  assert.equal(parseSource('..').type, 'local');
  assert.equal(parseSource('.').type, 'local');
});

test('owner/repo 简写 → git + github URL', () => {
  const p = parseSource('vercel-labs/agent-skills');
  assert.equal(p.type, 'git');
  assert.equal(p.url, 'https://github.com/vercel-labs/agent-skills.git');
  assert.equal(p.subpath, undefined);
});

test('owner/repo 简写带子路径与 #ref', () => {
  const p = parseSource('vercel-labs/agent-skills/skills/web-design-guidelines');
  assert.equal(p.type, 'git');
  assert.equal(p.subpath, 'skills/web-design-guidelines');

  const r = parseSource('vercel-labs/agent-skills#v1.2.0');
  assert.equal(r.ref, 'v1.2.0');
  assert.equal(r.url, 'https://github.com/vercel-labs/agent-skills.git');
});

test('github: / gitlab: 前缀', () => {
  assert.equal(parseSource('github:vercel-labs/agent-skills').url, 'https://github.com/vercel-labs/agent-skills.git');
  const gl = parseSource('gitlab:group/sub/repo');
  assert.equal(gl.type, 'git');
  assert.equal(gl.url, 'https://gitlab.com/group/sub/repo.git');
});

test('GitHub URL 三形：仓库 / tree 分支 / tree 子路径', () => {
  assert.equal(parseSource('https://github.com/o/r').url, 'https://github.com/o/r.git');
  const branch = parseSource('https://github.com/o/r/tree/main');
  assert.equal(branch.ref, 'main');
  const sub = parseSource('https://github.com/o/r/tree/main/skills/foo');
  assert.equal(sub.ref, 'main');
  assert.equal(sub.subpath, 'skills/foo');
});

test('GitLab URL：/-/tree 子路径（任意实例）与 gitlab.com 子组', () => {
  const sub = parseSource('https://gitlab.example.com/team/proj/-/tree/main/skills');
  assert.equal(sub.type, 'git');
  assert.equal(sub.url, 'https://gitlab.example.com/team/proj.git');
  assert.equal(sub.subpath, 'skills');

  const nested = parseSource('https://gitlab.com/g/s1/s2/repo');
  assert.equal(nested.url, 'https://gitlab.com/g/s1/s2/repo.git');
});

test('SSH 与任意 git URL', () => {
  assert.equal(parseSource('git@github.com:acme/private-skills.git').type, 'git');
  assert.equal(parseSource('ssh://git@git.example.com/acme/skills.git').type, 'git');
  assert.equal(parseSource('https://git.example.com/acme/skills.git').type, 'git');
});

test('file:// → git（测试夹具路径）', () => {
  const p = parseSource('file:///D:/tmp/fixture');
  assert.equal(p.type, 'git');
});

test('托管归档 / 原始文件 URL → download', () => {
  assert.equal(parseSource('https://github.com/o/r/archive/refs/heads/main.tar.gz').type, 'download');
  assert.equal(parseSource('https://raw.githubusercontent.com/o/r/main/skills/x/SKILL.md').type, 'download');
  assert.equal(parseSource('https://example.com/download/my-skill').type, 'download');
});

test('子路径穿越拒绝', () => {
  assert.throws(() => sanitizeSubpath('../evil'), AppError);
  assert.throws(() => parseSource('https://github.com/o/r/tree/main/../../etc'), AppError);
});

test('无法识别 → INVALID_INPUT', () => {
  assert.throws(() => parseSource('weird!!spec'), AppError);
  assert.throws(() => parseSource(''), AppError);
});

test('remoteSourceId：Windows 安全、子路径区分、长度截断', () => {
  const id1 = remoteSourceId(parseSource('vercel-labs/agent-skills'));
  assert.equal(id1, 'github.com--vercel-labs--agent-skills');

  const id2 = remoteSourceId(parseSource('vercel-labs/agent-skills/skills'));
  assert.notEqual(id1, id2);
  assert.ok(id2.startsWith(id1 + '--'));

  const ssh = remoteSourceId(parseSource('git@github.com:acme/private.git'));
  assert.equal(ssh, 'github.com--acme--private');

  const dl = remoteSourceId(parseSource('https://example.com/x.tar.gz'));
  assert.equal(dl, 'example.com--x.tar.gz');

  const long = remoteSourceId(parseSource('a/' + 'b'.repeat(200)));
  assert.ok(long.length <= 80);
});
