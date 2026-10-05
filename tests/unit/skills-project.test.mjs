// 当前项目子页的数据层：listProjectSkills（扫全部适配器项目级目录 + inHub 标注）、
// listAllSkills 的 projectSummary（总览「当前项目」入口）、submitSkill 的 into 选源。
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'nxrh-proj-'));
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
const proj = join(tmp, 'proj');

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
  await svc.addSkill({ name: 'hub-skill', description: '在订阅源里', content: '# hub\n' });

  // 项目目录：claude-code 放实体 stray；workbuddy 放指向 hub-skill 的链接；
  // 未启用的 cursor 平台也放一个（默认平台范围只有 claude-code）
  const settings = await import('../../src/modules/settings/service.js');
  await settings.updateSettings({ platforms: 'claude-code', defaultPlatform: 'claude-code' });
  mkSkill(join(proj, '.claude', 'skills', 'stray'), 'stray');
  mkdirSync(join(proj, '.workbuddy', 'skills'), { recursive: true });
  const linkedTarget = join(hub, 'hub-skill');
  symlinkSync(linkedTarget, join(proj, '.workbuddy', 'skills', 'hub-skill'), 'junction');
  mkSkill(join(proj, '.cursor', 'skills', 'cursor-only'), 'cursor-only');

  const listing = await svc.listProjectSkills({ project: proj });
  const names = listing.skills.map((s) => s.name);
  check('列出项目目录里的全部 skill', ['stray', 'hub-skill', 'cursor-only'].every((n) => names.includes(n)), JSON.stringify(names));
  check('inHub 标注正确', listing.skills.find((s) => s.name === 'stray').inHub === false
    && listing.skills.find((s) => s.name === 'hub-skill').inHub === true);
  check('目录清单含实体 / 链接 / 未启用平台', listing.dirs.some((d) => d.platform === 'claude-code' && !d.skills[0].linkType)
    && listing.dirs.some((d) => d.platform === 'workbuddy' && d.skills[0].linkType)
    && listing.dirs.some((d) => d.platform === 'cursor' && d.enabled === false));

  const summary = await svc.listAllSkills({ project: proj });
  check('projectSummary 计数', summary.projectSummary.count === 3, JSON.stringify(summary.projectSummary));
  check('projectSummary.orphan 只算不在订阅源的', summary.projectSummary.orphan === 2, JSON.stringify(summary.projectSummary));

  // submit into：收进指定订阅源；未订阅的 into 报 INVALID_INPUT
  const intoRes = await svc.submitSkill({ name: 'stray', to: 'project', project: proj, into: hub });
  check('submit into 收进指定源', intoRes.status === 'ok' && intoRes.into === resolve(hub)
    && existsSync(join(hub, 'stray', 'SKILL.md')), JSON.stringify(intoRes).slice(0, 160));
  check('submit into 未订阅目录 → INVALID_INPUT',
    (await errCode(() => svc.submitSkill({ name: 'hub-skill', into: join(tmp, 'elsewhere') }))) === CODES.INVALID_INPUT);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  log('失败项: ' + failed.map((f) => f.name).join(', '));
  process.exit(1);
}
