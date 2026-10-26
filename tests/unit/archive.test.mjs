// 归档解包回归：测试自合成 stored-zip 与 tar.gz（零依赖造夹具），
// 验证回读、路径穿越拒绝、条目数与解出字节上限。zip 读取器移植自
// vercel-labs/skills，安全行为必须有本地测试钉住。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, gzipSync } from 'node:zlib';
import { readArchive, readTarArchive, readZipArchive } from '../../src/core/archive.js';

const LIMITS = { maxDownloadBytes: 10 << 20, maxExtractedBytes: 25 << 20, maxEntries: 1000 };

// ---- 夹具：stored zip（无压缩，method 0） ----
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // utf8 flag
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(centrals.length / 2, 8);
  eocd.writeUInt16LE(centrals.length / 2, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

// ---- 夹具：tar（ustar） ----
function tarHeader(name, size, typeflag = '0') {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write(typeflag, 156);
  h.write('ustar\0', 257, 'latin1');
  h.write('00', 263, 'latin1');
  h.fill(' '.charCodeAt(0), 148, 156); // 校验和字段先置空格再算
  const sum = h.reduce((acc, b) => acc + b, 0);
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
  return h;
}

function buildTar(entries) {
  const parts = [];
  for (const [name, data] of entries) {
    parts.push(tarHeader(name, data.length));
    const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
    parts.push(data, pad);
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

const md = (name) => [
  `skills/${name}/SKILL.md`,
  Buffer.from(`---\nname: ${name}\ndescription: fixture\n---\n\n# ${name}\n`),
];

test('zip 回读', () => {
  const zip = buildZip([md('demo-a'), md('demo-b')]);
  const files = readZipArchive(zip, LIMITS);
  assert.equal(files.size, 2);
  assert.ok(files.get('skills/demo-a/SKILL.md').toString().includes('name: demo-a'));
});

test('tar.gz 回读（gzip 外壳）', () => {
  const tar = buildTar([md('demo-a'), ['skills/demo-b/x.txt', Buffer.from('hi')]]);
  const files = readTarArchive(gzipSync(tar), LIMITS);
  assert.equal(files.size, 2);
  assert.equal(files.get('skills/demo-b/x.txt').toString(), 'hi');
});

test('readArchive 按魔数分流', () => {
  const viaZip = readArchive(buildZip([md('z')]), LIMITS);
  const viaTar = readArchive(gzipSync(buildTar([md('t')])) , LIMITS);
  assert.ok(viaZip.has('skills/z/SKILL.md'));
  assert.ok(viaTar.has('skills/t/SKILL.md'));
});

test('zip 路径穿越拒绝（../ 与绝对路径）', () => {
  assert.throws(() => readZipArchive(buildZip([['../evil.txt', Buffer.from('x')]]), LIMITS), /unsafe path/);
  assert.throws(() => readZipArchive(buildZip([['/etc/evil.txt', Buffer.from('x')]]), LIMITS), /unsafe path/);
});

test('tar 路径穿越拒绝', () => {
  assert.throws(() => readTarArchive(gzipSync(buildTar([['../evil.txt', Buffer.from('x')]])), LIMITS), /unsafe path/);
});

test('tar symlink 条目拒绝', () => {
  const h = tarHeader('skills/s/SKILL.md', 0, '2');
  const tar = Buffer.concat([h, Buffer.alloc(1024)]);
  assert.throws(() => readTarArchive(tar, LIMITS), /links are not supported/);
});

test('条目数上限触发', () => {
  const small = { ...LIMITS, maxEntries: 2 };
  assert.throws(() => readZipArchive(buildZip([md('a'), md('b'), md('c')]), small), /too many files/);
  assert.throws(() => readTarArchive(buildTar([md('a'), md('b'), md('c')]), small), /too many files/);
});

test('解出字节上限触发', () => {
  const small = { ...LIMITS, maxExtractedBytes: 16 };
  const big = Buffer.alloc(32, 0x61);
  assert.throws(() => readTarArchive(buildTar([['skills/big/SKILL.md', big]]), small), /more than 16 bytes/);
});
