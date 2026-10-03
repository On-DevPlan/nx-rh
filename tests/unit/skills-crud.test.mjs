// skill 实体的 CRUD：只动订阅源里那份实文件（目标副本由 migrate 覆盖）。
// 读（R）由 show / cat 承担；刻意不声明 resource: 'skill'——`skill get` 这个 CLI
// 已被内置手册占用（bundled 模块），CRUD 断言要求的 get 动词没法按 A00 命名。
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'nxrh-crud-'));
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

function errCode(fn) {
  return fn().then(
    () => null,
    (e) => e.code || null
  );
}

try {
  await svc.addSource(hub);

  // 增
  const created = await svc.addSkill({ name: 'alpha', description: 'Alpha 的说明', content: '# Alpha\n\n正文\n' });
  check('add 创建目录与 SKILL.md', created.status === 'ok' && existsSync(join(hub, 'alpha', 'SKILL.md')));
  const md = readFileSync(join(hub, 'alpha', 'SKILL.md'), 'utf8');
  check('add 自动生成 frontmatter', md.includes('name: alpha') && md.includes('description: Alpha 的说明') && md.includes('# Alpha'));

  check('add 重复 → CONFLICT', (await errCode(() => svc.addSkill({ name: 'alpha' }))) === CODES.CONFLICT);

  // 只有正文时给全量 SKILL.md 也不二次包 frontmatter
  const raw = '---\nname: beta\ndescription: 完整文件直传\n---\n\n# Beta\n';
  await svc.addSkill({ name: 'beta', content: raw });
  check('add 支持直传完整 SKILL.md', readFileSync(join(hub, 'beta', 'SKILL.md'), 'utf8').includes('# Beta'));
  check('add 直传但 name 不一致 → INVALID_INPUT',
    (await errCode(() => svc.addSkill({ name: 'gamma', content: raw }))) === CODES.INVALID_INPUT);

  // 改
  await svc.updateSkill({ name: 'alpha', content: raw.replace('beta', 'alpha').replace('Beta', 'A2') });
  check('update 改写全文', readFileSync(join(hub, 'alpha', 'SKILL.md'), 'utf8').includes('# A2'));
  check('update 缺 frontmatter → INVALID_INPUT',
    (await errCode(() => svc.updateSkill({ name: 'alpha', content: '没有 frontmatter' }))) === CODES.INVALID_INPUT);
  check('update name 与目录名不一致 → INVALID_INPUT',
    (await errCode(() => svc.updateSkill({ name: 'alpha', content: raw }))) === CODES.INVALID_INPUT);
  check('update 不存在 → NOT_FOUND',
    (await errCode(() => svc.updateSkill({ name: 'nope', content: raw }))) === CODES.NOT_FOUND);

  // 删
  check('remove 不存在 → NOT_FOUND', (await errCode(() => svc.removeSkill({ name: 'nope' }))) === CODES.NOT_FOUND);
  const gone = await svc.removeSkill({ name: 'beta' });
  check('remove 无引用直接删', gone.status === 'ok' && !existsSync(join(hub, 'beta')));

  // 有引用 → blocked；force 才删
  const proj = join(tmp, 'proj');
  mkdirSync(join(proj, '.claude', 'skills'), { recursive: true });
  const link = join(proj, '.claude', 'skills', 'alpha');
  
  symlinkSync(join(hub, 'alpha'), link, 'junction');
  const blocked = await svc.removeSkill({ name: 'alpha', project: proj });
  check('remove 有目标引用 → blocked 并列出', blocked.status === 'blocked' && blocked.refs.length === 1, JSON.stringify(blocked).slice(0, 160));
  check('blocked 时不动磁盘', existsSync(join(hub, 'alpha', 'SKILL.md')));
  const forced = await svc.removeSkill({ name: 'alpha', force: true, project: proj });
  check('remove --force 删除并报告悬空', forced.status === 'ok' && !existsSync(join(hub, 'alpha')) && forced.dangling.length === 1);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) { log('失败项: ' + failed.map((f) => f.name).join(', ')); process.exit(1); }
