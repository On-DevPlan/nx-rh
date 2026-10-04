// 多 skill（脚手架 B04）：groups.json 的分组、三种 install 形态、降级与 schema 错误。
//
// 为什么直测 service 而不 spawn CLI：本机派子进程是 EBUSY（spawn 型断言只能在 CI 跑），
// 而这里要验的是**逻辑**——分组装载、降级、幂等、冲突聚合。CLI 路径能否解析由
// tests/unit/registry.test.mjs（cli 路径可解析回自身）+ CI 的 smoke 覆盖。
//
// 伪资产树走 NX_RH_ASSETS 指向临时目录（调用时读取），**绝不碰仓库里的 assets/**。
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'nxrh-multiskill-'));
const home = join(tmp, 'home');
mkdirSync(home, { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;

const assets = join(tmp, 'assets');
function mkSkill(name) {
  mkdirSync(join(assets, name), { recursive: true });
  writeFileSync(
    join(assets, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} 的说明\n---\n\n# ${name}\n\n正文\n`,
    'utf8'
  );
}
mkSkill('nx-rh');
mkSkill('extra');
process.env.NX_RH_ASSETS = assets;

const svc = await import('../../src/modules/bundled/service.js');
const { CODES } = await import('../../src/core/errors.js');

const to = join(tmp, 'skills');
const groupsFile = join(assets, 'groups.json');
const writeGroups = (obj) => writeFileSync(groupsFile, JSON.stringify(obj), 'utf8');
const VALID = {
  version: 1,
  groups: {
    'nx-rh': { skills: ['nx-rh'], summary: '主 skill' },
    both: { skills: ['nx-rh', 'extra'], summary: '两个一起' },
  },
};

const results = [];
const log = console.log;
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond });
  log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  -- ' + extra : ''));
}
const errCode = (fn) => fn().then(() => null, (e) => e.code || null);

try {
  // ── 1. groups.json 缺失 → 降级为目录扫描，不崩 ──
  const g1 = await svc.loadGroups();
  check('缺 groups.json 降级为目录扫描', g1.source === 'assets-dirs' && Object.keys(g1.groups).length === 2);

  // ── 2. 合法清单 ──
  writeGroups(VALID);
  const info = await svc.groupsInfo();
  check('默认组 = 包名（nx-rh）', info.defaultGroup === 'nx-rh', String(info.defaultGroup));
  check('列出包内 skill 与 group', info.skills.join() === 'extra,nx-rh' && info.groups.join() === 'nx-rh,both', item(info));
  check('数据来源标为 manifest', info.source === 'manifest');

  // ── 3. 三种 install 形态 ──
  const bare = await svc.installBundledSkill({ to });
  check('无参数 = 装默认 skill（与显式同名一致）', bare.name === 'nx-rh' && bare.status === 'ok' && existsSync(join(to, 'nx-rh', 'SKILL.md')));
  const named = await svc.installBundledSkill({ name: 'extra', to });
  check('显式装 extra', named.name === 'extra' && existsSync(join(to, 'extra', 'SKILL.md')));
  const byGroup = await svc.installBundledSkill({ group: 'both', to });
  check(
    '--group 装整组，走聚合形状（显式 group 字段）',
    byGroup.group === 'both' && Array.isArray(byGroup.skills) && byGroup.skills.length === 2 && byGroup.status === 'ok',
    item(byGroup)
  );

  // ── 4. 幂等 ──
  const again = await svc.installBundledSkill({ name: 'extra', to });
  check('二次安装 → skipped（不是 conflict）', again.skipped === true && again.status === 'ok');

  // ── 5. 冲突与 --force ──
  writeFileSync(join(to, 'extra', 'SKILL.md'), '---\nname: extra\ndescription: x\n---\n\n本地改过了\n', 'utf8');
  const conf = await svc.installBundledSkill({ name: 'extra', to });
  check('内容不同 → conflict（业务结果，不抛）', conf.status === 'conflict' && conf.count > 0, item(conf));
  const forced = await svc.installBundledSkill({ name: 'extra', to, force: true });
  check('--force 覆盖并报告 replaced', forced.status === 'ok' && forced.replaced === true);

  // ── 6. 组内部分冲突 → 聚合仍是 conflict ──
  writeFileSync(join(to, 'extra', 'SKILL.md'), '---\nname: extra\ndescription: y\n---\n\n又改了\n', 'utf8');
  const partial = await svc.installBundledSkill({ group: 'both', to });
  check(
    '组内部分冲突 → 聚合 status=conflict（逐条状态在 skills[] 里）',
    partial.status === 'conflict' && partial.skills.some((r) => r.status === 'conflict') && partial.skills.some((r) => r.status === 'ok'),
    item(partial.skills)
  );

  // ── 7. 未知 group：报错并给出可用列表（AI 能自纠） ──
  const bogus = await svc.installBundledSkill({ group: 'bogus', to }).then(() => null, (e) => e);
  check('未知 group → INVALID_INPUT 且列出可用 group',
    bogus && bogus.code === CODES.INVALID_INPUT && /nx-rh/.test(bogus.message), bogus && bogus.message);
  check('--group 空值也报错', (await errCode(() => svc.installBundledSkill({ group: '  ', to }))) === CODES.INVALID_INPUT);

  // ── 8. schema 错必须显式报错（不能静默吞） ──
  writeGroups({ version: 1 });
  check('缺 groups 对象 → INVALID_INPUT', (await errCode(() => svc.loadGroups())) === CODES.INVALID_INPUT);
  writeGroups({ version: 1, groups: { x: { summary: '没有 skills' } } });
  check('某组缺 skills 数组 → INVALID_INPUT', (await errCode(() => svc.loadGroups())) === CODES.INVALID_INPUT);
  writeGroups({ version: 1, groups: { x: { skills: ['../逃逸'] } } });
  check('组内 skill 名非法 → INVALID_INPUT', (await errCode(() => svc.loadGroups())) === CODES.INVALID_INPUT);

  // ── 9. JSON 损坏 → 降级（不崩、不报 schema 错） ──
  writeFileSync(groupsFile, '{ 这不是 JSON', 'utf8');
  const broken = await svc.loadGroups();
  check('JSON 损坏 → 降级为目录扫描', broken.source === 'assets-dirs');

  // ── 10. get --group：取整组全文 ──
  writeGroups(VALID);
  const got = await svc.bundledSkillContent({ group: 'both', to });
  check('get --group 取回整组全文',
    got.group === 'both' && got.skills.length === 2 && got.skills.every((x) => x.content.includes(`name: ${x.skillName}`)),
    item(got.skills.map((x) => x.skillName)));
  check('get --group 与 get <name> 互斥由 CLI 层拦（service 只管 group）',
    (await svc.bundledSkillContent({ name: 'extra', to })).skillName === 'extra');

  // ── 11. 不存在的 skill ──
  check('装不存在的内置 skill → NOT_FOUND', (await errCode(() => svc.installBundledSkill({ name: 'nope', to }))) === CODES.NOT_FOUND);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

function item(x) {
  return JSON.stringify(x).slice(0, 170);
}

const failed = results.filter((r) => !r.ok);
log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  log('失败项: ' + failed.map((f) => f.name).join(', '));
  process.exit(1);
}
