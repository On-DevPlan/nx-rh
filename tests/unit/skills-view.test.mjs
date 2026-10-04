// 「完整查看 + 删除」：未入 Hub 的 skill（只在平台目录里的链接/副本）也必须能读、能删。
//
// 这一组断言来自实测缺口：面板的「查看全文」只查订阅源，未入 Hub 的 skill 点进去
// 必然 NOT_FOUND；面板上也**没有任何**能删掉这类 skill 的操作（skill remove 只动订阅源那份）。
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'nxrh-view-'));
const home = join(tmp, 'home');
mkdirSync(home, { recursive: true });
process.env.NX_RH_STORE = join(tmp, 'store.json');
process.env.HOME = home;
process.env.USERPROFILE = home;

const results = [];
const log = console.log;
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond });
  log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  -- ' + extra : ''));
}

const svc = await import('../../src/modules/skills/service.js');
const { CODES } = await import('../../src/core/errors.js');

const hub = join(tmp, 'hub');
mkdirSync(hub, { recursive: true });
// 用户级 claude-code 落点：~/.claude/skills（HOME 已指到临时目录）
const userSkills = join(home, '.claude', 'skills');
mkdirSync(userSkills, { recursive: true });

function errCode(fn) {
  return fn().then(() => null, (e) => e.code || null);
}
function mkSkill(dir, name, body = '# 正文\n') {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} 的说明\n---\n\n${body}`,
    'utf8'
  );
}

try {
  await svc.addSource(hub);
  await svc.addSkill({ name: 'in-hub', description: '在订阅源里', content: '# hub\n' });

  // ── 未入 Hub：平台目录里的实体副本 ──
  const stray = join(userSkills, 'stray-copy');
  mkSkill(stray, 'stray-copy');
  mkdirSync(join(stray, 'references'), { recursive: true });
  writeFileSync(join(stray, 'references', 'api.md'), '# API\n', 'utf8');

  const detail = await svc.skillInfo({ name: 'stray-copy' });
  check('未入 Hub 的详情 origin=target', detail.origin === 'target', detail.origin);
  check(
    '未入 Hub 的详情带文件清单（含子目录，SKILL.md 在前）',
    detail.files.map((f) => f.path).join(',') === 'SKILL.md,references/api.md',
    JSON.stringify(detail.files.map((f) => f.path))
  );
  check('未入 Hub 的详情有结构大纲', (detail.outline || []).length > 0);
  check('未入 Hub 的详情不标 broken', detail.broken === false);

  const cat = await svc.skillContent({ name: 'stray-copy' });
  check('未入 Hub 能读全文（改前必 NOT_FOUND）', cat.content.includes('stray-copy') && cat.origin === 'target');
  const sub = await svc.skillContent({ name: 'stray-copy', ref: 'references/api.md' });
  check('未入 Hub 能读子文件', sub.content.includes('# API'));

  // ── 未入 Hub：链接（顺着链接读） ──
  const linked = join(tmp, 'elsewhere', 'linked');
  mkSkill(linked, 'linked');
  symlinkSync(linked, join(userSkills, 'linked'), 'junction');
  const linkCat = await svc.skillContent({ name: 'linked' });
  check(
    '链接形态的未入 Hub 能顺着链接读',
    linkCat.content.includes('linked') && linkCat.origin === 'link',
    linkCat.origin
  );

  // ── 断链：如实标 broken，而不是装作不存在 ──
  const gone = join(tmp, 'gone');
  mkdirSync(gone, { recursive: true });
  symlinkSync(gone, join(userSkills, 'dangling'), 'junction');
  rmSync(gone, { recursive: true, force: true }); // 目标消失 → 悬空链接
  const dead = await svc.skillInfo({ name: 'dangling' });
  check(
    '断链的详情标 broken 且没有文件',
    dead.broken === true && dead.files.length === 0,
    JSON.stringify({ broken: dead.broken, files: dead.files.length })
  );
  check(
    '断链读全文 → NOT_FOUND（信息里说明是断链）',
    (await errCode(() => svc.skillContent({ name: 'dangling' }))) === CODES.NOT_FOUND
  );

  // ── 删除：dry-run 先看清单 ──
  const dry = await svc.purgeSkill({ name: 'stray-copy', dryRun: true });
  check('purge --dry-run 不改磁盘', dry.dryRun === true && existsSync(join(stray, 'SKILL.md')));
  check(
    'purge 计划列出落点、且源为空',
    dry.plan.targets.length === 1 && dry.plan.sources.length === 0,
    JSON.stringify(dry.plan).slice(0, 160)
  );

  // 实体副本要 force
  const blocked = await svc.purgeSkill({ name: 'stray-copy' });
  check('purge 遇实体副本 → blocked 并计数', blocked.status === 'blocked' && blocked.plan.copies === 1);
  check('blocked 时不动磁盘', existsSync(stray));
  const done = await svc.purgeSkill({ name: 'stray-copy', force: true });
  check('purge --force 真删掉实体副本', done.status === 'ok' && !existsSync(stray) && done.removed.length === 1);

  // 链接不需要 force —— 而且删链接**不能**连带删掉它的目标
  const linkPurge = await svc.purgeSkill({ name: 'linked' });
  check('purge 链接无需 --force', linkPurge.status === 'ok' && !existsSync(join(userSkills, 'linked')));
  check('删链接不动它的目标（关键：不能连带删真实数据）', existsSync(join(linked, 'SKILL.md')));

  // 订阅源里的 skill：源那份一起删
  const inHub = await svc.skillContent({ name: 'in-hub' });
  check('订阅源 skill 可读且 origin=source', inHub.origin === 'source');
  const hubPurge = await svc.purgeSkill({ name: 'in-hub' });
  check('purge 订阅源 skill 会删掉源那份', hubPurge.status === 'ok' && !existsSync(join(hub, 'in-hub')));

  check('purge 不存在的名字 → NOT_FOUND', (await errCode(() => svc.purgeSkill({ name: 'nope' }))) === CODES.NOT_FOUND);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  log('失败项: ' + failed.map((f) => f.name).join(', '));
  process.exit(1);
}
