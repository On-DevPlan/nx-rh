// 冒烟测试：CLI 全链路 + Web API + 静态页。
// 使用临时存储（NX_RH_STORE），不污染用户目录 ~/.nx-rh。
// 运行：pnpm test（或 node tests/smoke.mjs）
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const BIN = join(ROOT, '..', 'bin', 'cli.mjs');

const tmp = mkdtempSync(join(tmpdir(), 'nx-rh-smoke-'));
const storePath = join(tmp, 'store.json');
// 本进程（含稍后动态 import 的 web server）也必须指向临时存储
process.env.NX_RH_STORE = storePath;
const central = join(tmp, 'central');
const project = join(tmp, 'project');
const project2 = join(tmp, 'project2');

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond });
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  -- ' + extra : ''));
}

function cli(args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    env: { ...process.env, NX_RH_STORE: storePath },
    encoding: 'utf8',
  });
}

function cliJson(args) {
  const r = cli([...args, '--json']);
  if (r.status !== 0) {
    return { __error: r.stdout + r.stderr };
  }
  return JSON.parse(r.stdout);
}

// ---- fixtures ----
mkdirSync(join(central, 'skills', 'demo-skill'), { recursive: true });
writeFileSync(
  join(central, 'skills', 'demo-skill', 'SKILL.md'),
  '---\nname: demo-skill\ndescription: smoke test skill\n---\n\n# Demo\n\nhello\n'
);
mkdirSync(join(project, '.claude'), { recursive: true });
mkdirSync(project2, { recursive: true });

try {
  // ---- 1. 基础命令 ----
  const pkgVersion = JSON.parse(readFileSync(join(ROOT, '..', 'package.json'), 'utf8')).version;
  check('cli version', cli(['version']).stdout.trim() === pkgVersion);
  check('cli help', cli(['help']).stdout.includes('repo add'));
  check('cli unknown -> exit 1', cli(['nope']).status === 1);

  // ---- 2. 设置 ----
  check('skill central set', cli(['skill', 'central', central]).status === 0);
  const settings = cliJson(['setting', 'get']);
  check('setting get', settings.skillCentralPath === central);

  // ---- 3. 仓库 CRUD ----
  check('repo add', cli(['repo', 'add', central, '--name', 'central-repo', '--tags', 'test,fixture']).status === 0);
  check('repo add 重复路径报错', cli(['repo', 'add', central]).status === 1);
  const list = cliJson(['repo', 'list']);
  check('repo list --json', Array.isArray(list) && list.length === 1 && list[0].name === 'central-repo');

  // git 仓库状态（用参考克隆）
  const skillsRepo = join(ROOT, '..', '.claude', 'repo', 'skills');
  check('repo add git repo', cli(['repo', 'add', skillsRepo, '--name', 'skills-ref']).status === 0);
  const statuses = cliJson(['repo', 'status']);
  const gitRow = Array.isArray(statuses) ? statuses.find((r) => r.name === 'skills-ref') : null;
  check('git status 解析', !!gitRow && !!gitRow.git.branch && !gitRow.git.error, gitRow && gitRow.git.branch);
  const nonGit = Array.isArray(statuses) ? statuses.find((r) => r.name === 'central-repo') : null;
  check('非 git 目录状态容错', !!nonGit && !!nonGit.git.error);

  // ---- 4. skill 识别 ----
  const centralSkills = cliJson(['skill', 'list', '--side', 'central']);
  check('central skill 识别', Array.isArray(centralSkills) && centralSkills.length === 1 && centralSkills[0].name === 'demo-skill');

  // ---- 5. 软链接同步（Windows 上应为 junction） ----
  const sync = cliJson(['skill', 'sync', 'demo-skill', '--project', project, '--mode', 'symlink']);
  check('skill sync symlink', sync.status === 'ok' && (sync.linkType === 'junction' || sync.linkType === 'symlink'), JSON.stringify(sync));
  const projSkills = cliJson(['skill', 'list', '--side', 'project', '--path', project]);
  check('项目侧识别为链接', Array.isArray(projSkills) && projSkills.length === 1 && !!projSkills[0].linkType, String(projSkills[0] && projSkills[0].linkType));
  const syncAgain = cliJson(['skill', 'sync', 'demo-skill', '--project', project, '--mode', 'symlink']);
  check('重复同步幂等跳过', syncAgain.status === 'ok' && syncAgain.skipped === true);

  // ---- 6. 复制模式同步 ----
  const syncCopy = cliJson(['skill', 'sync', 'demo-skill', '--project', project2, '--mode', 'copy']);
  check('skill sync copy', syncCopy.status === 'ok' && syncCopy.mode === 'copy', JSON.stringify(syncCopy));

  // ---- 7. 物化 ----
  const mat = cliJson(['skill', 'materialize', 'demo-skill', '--project', project]);
  check('materialize 转实体', mat.converted === true);
  const projSkills2 = cliJson(['skill', 'list', '--side', 'project', '--path', project]);
  check('物化后无链接形态', Array.isArray(projSkills2) && projSkills2.length === 1 && !projSkills2[0].linkType);

  // ---- 8. 冲突检测与选侧 ----
  const skillMd = join(project, '.claude', 'skills', 'demo-skill', 'SKILL.md');
  writeFileSync(skillMd, readFileSync(skillMd, 'utf8').replace('hello', 'hello-edited'));
  const conf = cliJson(['skill', 'conflict', 'demo-skill', '--project', project]);
  check('冲突检测', conf.files.length === 1 && conf.files[0].side === 'both-differ' && !!conf.files[0].diff.includes('@@'));
  const syncConf = cliJson(['skill', 'sync', 'demo-skill', '--project', project, '--mode', 'copy']);
  check('同步遇冲突返回 conflict', syncConf.status === 'conflict');
  check('apply 选中心侧', cli(['skill', 'apply', 'demo-skill', '--project', project, '--file', 'SKILL.md', '--side', 'central']).status === 0);
  const conf2 = cliJson(['skill', 'conflict', 'demo-skill', '--project', project]);
  check('冲突已解决', conf2.files.length === 0);

  // ---- 9. 推送到中心 ----
  writeFileSync(skillMd, readFileSync(skillMd, 'utf8').replace('hello', 'hello-pushed'));
  const pushed = cliJson(['skill', 'push', 'demo-skill', '--project', project, '--force']);
  check('skill push 到中心', pushed.status === 'ok');
  const centralAfter = cliJson(['skill', 'list', '--side', 'central']);
  check('中心内容已更新', centralAfter[0].md5 !== centralSkills[0].md5);

  // ---- 10. 路径穿越防护 ----
  check('非法 skill 名称拒绝', cli(['skill', 'sync', '../evil', '--project', project]).status === 1);

  // ---- 11. merge3 原语 ----
  const baseF = join(tmp, 'base.txt');
  const aF = join(tmp, 'a.txt');
  const bF = join(tmp, 'b.txt');
  writeFileSync(baseF, 'line1\nline2\nline3\n');
  writeFileSync(aF, 'line1\nline2-a\nline3\n');
  writeFileSync(bF, 'line1\nline2\nline3-b\n');
  const merged = cliJson(['skill', 'merge', '--base', baseF, '--a', aF, '--b', bF]);
  check('merge3 无冲突自动合并', merged.merged.includes('line2-a') && merged.merged.includes('line3-b') && merged.conflicts.length === 0);
  writeFileSync(bF, 'line1\nline2-b\nline3\n');
  const merged2 = cliJson(['skill', 'merge', '--base', baseF, '--a', aF, '--b', bF]);
  check('merge3 双侧冲突标记', merged2.conflicts.length === 1 && merged2.merged.includes('<<<<<<<'));

  // ---- 12. SKILL.md frontmatter 解析（CRLF / 块标量 / 引号） ----
  const crlfProject = join(tmp, 'crlf-project');
  mkdirSync(join(crlfProject, '.claude', 'skills', 'crlf-skill'), { recursive: true });
  writeFileSync(
    join(crlfProject, '.claude', 'skills', 'crlf-skill', 'SKILL.md'),
    '---\r\nname: crlf-skill\r\ndescription: 换行是 CRLF 时也要能读出描述\r\n---\r\n\r\n# body\r\n'
  );
  mkdirSync(join(crlfProject, '.claude', 'skills', 'block-skill'), { recursive: true });
  writeFileSync(
    join(crlfProject, '.claude', 'skills', 'block-skill', 'SKILL.md'),
    '---\nname: block-skill\ndescription: >\n  折叠块标量\n  要合并成一行\n---\n\n# body\n'
  );
  mkdirSync(join(crlfProject, '.claude', 'skills', 'quoted-skill'), { recursive: true });
  writeFileSync(
    join(crlfProject, '.claude', 'skills', 'quoted-skill', 'SKILL.md'),
    '---\nname: quoted-skill\ndescription: "带引号的描述"\n---\n\n# body\n'
  );
  const parsed = cliJson(['skill', 'list', '--side', 'project', '--path', crlfProject]);
  const byName = Object.fromEntries((parsed || []).map((s) => [s.name, s.description]));
  check('CRLF frontmatter 描述解析', byName['crlf-skill'] === '换行是 CRLF 时也要能读出描述', JSON.stringify(byName['crlf-skill']));
  check('折叠块标量描述解析', byName['block-skill'] === '折叠块标量 要合并成一行', JSON.stringify(byName['block-skill']));
  check('引号描述解析', byName['quoted-skill'] === '带引号的描述', JSON.stringify(byName['quoted-skill']));

  // ---- 13. 内置 skill 包安装（repo-hub） ----
  const skillsHome = join(tmp, 'claude-skills');
  const bundleList = cliJson(['skill', 'install', '--list']);
  check(
    'bundled 列表含 repo-hub',
    Array.isArray(bundleList) && bundleList.some((s) => s.name === 'repo-hub' && s.files >= 4),
    JSON.stringify(bundleList && bundleList.map((s) => s.name + ':' + s.files))
  );

  const inst = cliJson(['skill', 'install', '--to', skillsHome]);
  check('skill install 安装成功', inst.status === 'ok' && inst.installed === true && inst.files >= 4, JSON.stringify(inst));
  const installedMd = readFileSync(join(skillsHome, 'repo-hub', 'SKILL.md'), 'utf8');
  check('SKILL.md 落地且含 ref-map', installedMd.includes('场景路由（ref-map）') && installedMd.includes('[[repo-ops]]'));
  check('references 一并复制', existsSync(join(skillsHome, 'repo-hub', 'references', 'skill-sync.md')));

  const again = cliJson(['skill', 'install', '--to', skillsHome]);
  check('重复安装幂等跳过', again.status === 'ok' && again.skipped === true);

  writeFileSync(join(skillsHome, 'repo-hub', 'SKILL.md'), installedMd + '\n<!-- local edit -->\n');
  const conflicted = cliJson(['skill', 'install', '--to', skillsHome]);
  check('内容被改后返回 conflict', conflicted.status === 'conflict' && conflicted.count >= 1);
  const notForced = readFileSync(join(skillsHome, 'repo-hub', 'SKILL.md'), 'utf8');
  check('未加 --force 不覆盖', notForced.includes('local edit'));

  const forced = cliJson(['skill', 'install', '--to', skillsHome, '--force']);
  check('--force 覆盖为包内版本', forced.status === 'ok' && forced.replaced === true);
  check('覆盖后本地改动消失', !readFileSync(join(skillsHome, 'repo-hub', 'SKILL.md'), 'utf8').includes('local edit'));

  check('非法包名被拒', cli(['skill', 'install', '../evil', '--to', skillsHome]).status === 1);

  // ---- 13. 中心根目录布局 + 平台开关 + 多选比较 ----
  const central2 = join(tmp, 'central-root'); // 根目录直接是 skill（新布局）
  mkdirSync(join(central2, 'root-skill'), { recursive: true });
  writeFileSync(
    join(central2, 'root-skill', 'SKILL.md'),
    '---\nname: root-skill\ndescription: 根布局 skill\n---\n\n# R\n'
  );
  const proj3 = join(tmp, 'proj3');
  mkdirSync(join(proj3, '.claude'), { recursive: true });

  check('skill central add', cli(['skill', 'central', 'add', central2]).status === 0);
  const cs2 = cliJson(['skill', 'list', '--side', 'central', '--path', central2]);
  check('中心根目录布局识别', Array.isArray(cs2) && cs2.length === 1 && cs2[0].name === 'root-skill', JSON.stringify(cs2 && cs2.map((x) => x.name)));

  const syncP = cliJson(['skill', 'sync', 'root-skill', '--project', proj3, '--adapter', 'claude-code']);
  check('同步到指定平台', syncP.status === 'ok', JSON.stringify(syncP));

  const platOn = cliJson(['skill', 'platform-set', 'root-skill', '--project', proj3, '--adapter', 'cursor']);
  check('平台开关-开(cursor)', platOn.status === 'ok' && platOn.platform === 'cursor', JSON.stringify(platOn));

  const cmp = cliJson(['skill', 'compare', '--central', central2, '--project', proj3]);
  check(
    '多选比较汇总',
    cmp.summary && cmp.summary.linked >= 1 && cmp.rows.length === 1 && cmp.rows[0].platforms.length === 2,
    JSON.stringify(cmp.summary)
  );

  const platOff = cliJson(['skill', 'platform-set', 'root-skill', '--project', proj3, '--adapter', 'cursor', '--off']);
  check('平台开关-关(cursor)', platOff.removed === true, JSON.stringify(platOff));
  const cmp2 = cliJson(['skill', 'compare', '--central', central2, '--project', proj3]);
  check('关闭后平台计数更新', cmp2.rows[0].platforms.length === 1, JSON.stringify(cmp2.rows[0].platforms));

  check('project 候选添加', cli(['skill', 'project', 'add', proj3]).status === 0);
  const pList = cliJson(['skill', 'project', 'list']);
  check('project 候选列表', Array.isArray(pList) && pList.some((x) => x === proj3));

  // ---- 14. Web API ----
  const { startServer } = await import(pathToFileURL(join(ROOT, '..', 'src', 'web', 'server.js')).href);
  const server = await startServer({ port: 0 });
  const base = 'http://127.0.0.1:' + server.address().port;

  const boot = await (await fetch(base + '/api/bootstrap')).json();
  check('api bootstrap', boot.ok && boot.data.repos.length === 2);

  const html = await (await fetch(base + '/')).text();
  check('web 首页', html.includes('npx-repo-hub') && !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(html));

  const addRes = await (
    await fetch(base + '/api/repos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: project2, name: 'proj2' }),
    })
  ).json();
  check('api repo add', addRes.ok && addRes.data.name === 'proj2');

  const skillsRes = await (
    await fetch(base + '/api/skills?side=project&path=' + encodeURIComponent(project))
  ).json();
  check('api skills project', skillsRes.ok && skillsRes.data.length === 1);

  const bundledRes = await (await fetch(base + '/api/bundled')).json();
  check(
    'api bundled 列表',
    bundledRes.ok && bundledRes.data.skills.some((s) => s.name === 'repo-hub') && !!bundledRes.data.defaultDir
  );

  const badRes = await (
    await fetch(base + '/api/repos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: central }),
    })
  ).json();
  check('api 重复添加报错', !badRes.ok && /已登记/.test(badRes.error));

  const notFound = await (await fetch(base + '/api/nothing')).json();
  check('api 404', !notFound.ok);

  await new Promise((r) => server.close(r));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log('失败项: ' + failed.map((f) => f.name).join(', '));
  process.exit(1);
}
