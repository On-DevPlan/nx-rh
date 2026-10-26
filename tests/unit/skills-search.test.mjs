// skill hub search 回归：对接 skills.sh 的 /api/search。
// 用进程内 http 假注册表（NX_RH_SKILLS_SH_URL 指向本地），全程不碰外网。
// 钉住：参数校验、按安装量排序、字段清洗（终端转义注入要剥）、失败分类。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/api/search') {
    res.writeHead(404);
    res.end('nope');
    return;
  }
  const q = url.searchParams.get('q') || '';
  const owner = url.searchParams.get('owner') || '';
  if (q === 'boom') {
    res.writeHead(500);
    res.end('server error');
    return;
  }
  if (q === 'garbage') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('not-json{');
    return;
  }
  if (q === 'inject') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      skills: [
        { id: 'a/b@evil\x1b[31mRED', name: 'ev\x1b]0;pwned\x07il', source: 'a/b', installs: 1 },
        { id: 'c/d@x', name: '', source: 'c/d', installs: 9 }, // 空 name 应被滤掉
      ],
    }));
    return;
  }
  // 默认：两条结果，installs 乱序给，断言排序；带 owner 时只回该 owner 的结果
  res.writeHead(200, { 'content-type': 'application/json' });
  const rows = owner
    ? [{ id: `${owner}/r@few`, name: 'few', source: `${owner}/r`, installs: 3 }]
    : [
        { id: 'o/r@few', name: 'few', source: 'o/r', installs: 3 },
        { id: 'o/popular', name: 'popular', source: 'o/popular', installs: 99 },
      ];
  res.end(JSON.stringify({ skills: rows }));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.NX_RH_SKILLS_SH_URL = `http://127.0.0.1:${server.address().port}`;

const { searchRegistry, sanitizeMeta } = await import('../../src/modules/skills/svc/search.js');

after(() => server.close());

test('正常搜索：转参数、按安装量降序、带 query/owner 回显', async () => {
  const r = await searchRegistry({ query: 'web design' });
  assert.equal(r.status, 'ok');
  assert.equal(r.results[0].name, 'popular');
  assert.equal(r.results.length, 2);

  const o = await searchRegistry({ query: 'react', owner: 'vercel' });
  assert.equal(o.owner, 'vercel');
  assert.ok(o.results.every((x) => x.source.startsWith('vercel/')));
});

test('关键词与 owner 校验', async () => {
  await assert.rejects(() => searchRegistry({ query: '' }), (e) => e.code === 'INVALID_INPUT');
  await assert.rejects(() => searchRegistry({ query: 'x' }), (e) => e.code === 'INVALID_INPUT'); // <2 字符
  await assert.rejects(() => searchRegistry({ query: 'ok', owner: 'not valid!' }), (e) => e.code === 'INVALID_INPUT');
});

test('注册表 5xx / 非 JSON → EXTERNAL', async () => {
  await assert.rejects(() => searchRegistry({ query: 'boom' }), (e) => e.code === 'EXTERNAL');
  await assert.rejects(() => searchRegistry({ query: 'garbage' }), (e) => e.code === 'EXTERNAL');
});

test('结果清洗：终端转义序列剥除、空名滤掉', async () => {
  const r = await searchRegistry({ query: 'inject' });
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].name, 'evil'); // OSC 段与 BEL 一起剥掉
  assert.equal(r.results[0].slug, 'a/b@evilRED'); // CSI 剥掉，尾随文本保留
  assert.ok(!JSON.stringify(r).includes('pwned'));
});

test('sanitizeMeta：控制字符与转义序列', () => {
  assert.equal(sanitizeMeta('a\x1b[31mb'), 'ab');
  assert.equal(sanitizeMeta('x\x07y'), 'xy');
  assert.equal(sanitizeMeta('正常文本'), '正常文本');
  assert.equal(sanitizeMeta(null), '');
});
