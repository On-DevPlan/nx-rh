// 内置 skill 包：随 nx-rh 一起发布的 assets/<name>/（SKILL.md + references/…）
// 负责列出与安装到用户/项目的 skills 目录，供 agent 一键获得 nx-rh 的使用说明。
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fsp from 'node:fs/promises';
import { diffTrees } from '../../core/fstree.js';
import { parseFrontmatter } from '../../core/frontmatter.js';
import { assertSafeName } from '../../core/paths.js';
import { notFound, badInput } from '../../core/errors.js';

// assets/ 在包根，src/modules/bundled/ 的上三级
const DEFAULT_ASSETS_DIR = fileURLToPath(new URL('../../../assets/', import.meta.url));

// assets 根。NX_RH_ASSETS 可覆盖，且**在调用时读、不在模块加载时快照**——
// 测试要拿一棵伪资产树验 groups.json 的降级 / schema 错误，绝不能真去改仓库里的 assets/。
function assetsRoot() {
  return process.env.NX_RH_ASSETS ? resolve(process.env.NX_RH_ASSETS) : DEFAULT_ASSETS_DIR;
}

// 默认安装到 Claude Code 的用户级 skills 目录
export const DEFAULT_SKILLS_DIR = join(homedir(), '.claude', 'skills');

// 内置 skill 的规范名 = 包名（A03 §二：用户不必记两个名字）。
// repo-hub 是改名前的旧名，保留为别名，免得既有引用与肌肉记忆一夜失效。
const NAME_ALIASES = { 'repo-hub': 'nx-rh' };

export const DEFAULT_SKILL_NAME = 'nx-rh';

function canonicalName(name) {
  const k = String(name || '').trim();
  return NAME_ALIASES[k] || k;
}

// ─── B04：多 skill 的分组（assets/groups.json） ──────────────────────
//
// 事实源只有一个：`assets/<name>/SKILL.md`。`groups.json` 只是「便捷别名表」——
// 它缺失或损坏时降级成「每个 assets/<x> 各成一组」，用户照样能装，只是没了 --group。
// 但 **schema 错**（缺 groups、某组缺 skills、skill 名非法）必须显式报错：
// 那是作者/打包事故，静默吞掉只会让排查抓瞎（B04 的错误与降级表）。

const GROUPS_REL = 'groups.json';

// 包内实际存在的 skill：靠 assets/<x>/SKILL.md 判定
async function assetSkillDirs() {
  const entries = await fsp.readdir(assetsRoot(), { withFileTypes: true }).catch(() => []);
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (await pathExists(join(assetsRoot(), e.name, 'SKILL.md'))) out.push(e.name);
  }
  return out.sort();
}

function degradeGroups(names) {
  const groups = {};
  for (const n of names) {
    groups[n] = { skills: [n], summary: '（groups.json 缺失或损坏，按目录扫描兜底）' };
  }
  return groups;
}

export async function loadGroups() {
  const raw = await fsp.readFile(join(assetsRoot(), GROUPS_REL), 'utf8').catch(() => null);
  if (raw === null) return { groups: degradeGroups(await assetSkillDirs()), source: 'assets-dirs' };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.stderr.write('[nx-rh] assets/groups.json 不是合法 JSON，已降级为目录扫描\n');
    return { groups: degradeGroups(await assetSkillDirs()), source: 'assets-dirs' };
  }

  const g = parsed && parsed.groups;
  if (!g || typeof g !== 'object' || Array.isArray(g)) {
    throw badInput('assets/groups.json 缺少 groups 对象（schema 错）');
  }
  const groups = {};
  for (const [key, val] of Object.entries(g)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) throw badInput(`assets/groups.json 的 group 名非法: ${key}`);
    if (!val || !Array.isArray(val.skills) || !val.skills.length) {
      throw badInput(`assets/groups.json 的 group "${key}" 缺少非空 skills 数组（schema 错）`);
    }
    for (const s of val.skills) assertSafeName(s, 'group 里的 skill 名');
    // 同一组里重复的 skill 名去重，避免重复三态与重复计数
    groups[key] = { skills: [...new Set(val.skills)], summary: String(val.summary || '') };
  }
  if (!Object.keys(groups).length) throw badInput('assets/groups.json 里没有任何 group（schema 错）');
  return { groups, source: 'manifest' };
}

// 默认 group 名 = 包名（B04「默认 install 的约定」）。
// ref 写的是读 `process.cwd()/package.json`；这里改读**本包自己的** package.json——
// 全局安装时 cwd 是用户目录，读 cwd 永远匹配不上，标记会静默消失。读不到就 null（不崩）。
let pkgNameCache;
async function packageName() {
  if (pkgNameCache !== undefined) return pkgNameCache;
  const own = fileURLToPath(new URL('../../../package.json', import.meta.url));
  for (const p of [own, join(process.cwd(), 'package.json')]) {
    try {
      const name = JSON.parse(await fsp.readFile(p, 'utf8')).name;
      if (name) { pkgNameCache = String(name); return pkgNameCache; }
    } catch { /* 换下一个 */ }
  }
  pkgNameCache = null;
  return pkgNameCache;
}

async function resolveGroup(key) {
  const k = String(key ?? '').trim();
  if (!k) throw badInput('--group 需要一个值（可用: ' + (Object.keys((await loadGroups()).groups).join(', ') || '(无)') + '）');
  if (k.startsWith('-')) throw badInput(`--group 的值不能以 - 开头: ${k}`);
  const { groups } = await loadGroups();
  const g = groups[k];
  if (!g) throw badInput(`未知 group: ${k}（可用: ${Object.keys(groups).join(', ') || '(无)'}）`);
  return g;
}

// `skill list` 的数据：可装的 skill + 默认装哪个 + 有哪些 group + 数据来源
export async function groupsInfo() {
  const { groups, source } = await loadGroups();
  const ids = Object.keys(groups);
  const def = await packageName();
  return {
    skills: await assetSkillDirs(),
    // 标记只认「与包名同名」的那一项；无匹配就不显示标记（不崩）
    defaultGroup: def && groups[def] ? def : null,
    groups: ids,
    summaries: Object.fromEntries(ids.map((id) => [id, groups[id].summary])),
    groupSkills: Object.fromEntries(ids.map((id) => [id, groups[id].skills])),
    source,
  };
}

async function pathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export function assetsDir() {
  return assetsRoot();
}

// 列出包内自带的所有 skill（含文件数与描述）
export async function listBundledSkills() {
  const out = [];
  const entries = await fsp.readdir(assetsRoot(), { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = join(assetsRoot(), e.name);
    // 用不存在的路径当哨兵，diffTrees 会把包内文件全列为 only-central，等于列出文件清单
    const files = await diffTrees(dir, join(dir, '__nx_rh_missing__'));
    if (!files.length) continue;

    // 描述解析复用 core/frontmatter.js —— 这里原本抄了一份简化正则，
    // 于是 CRLF / 块标量 / 引号的处理与 skills 侧并不一致。
    const md = await fsp.readFile(join(dir, 'SKILL.md'), 'utf8').catch(() => null);
    const description = md ? parseFrontmatter(md).description : '';
    out.push({ name: e.name, dir, files: files.length, description });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// 安装**一个**内置 skill。返回值形状与历史逐字节兼容，只多一个 `group` 字段
// （B04 §实现要点：判别单/多 skill 必须用显式 `group` 字段，不做形状嗅探——
//  「装一个」的退化结果里也可能带数组）。
async function installOne(name, { to, force } = {}) {
  name = assertSafeName(canonicalName(name));
  const src = join(assetsRoot(), name);
  if (!(await pathExists(join(src, 'SKILL.md')))) {
    const available = (await assetSkillDirs()).join(', ') || '(无)';
    throw notFound(`未找到内置 skill: ${name}（可用: ${available}）`);
  }

  const targetRoot = resolve(to || DEFAULT_SKILLS_DIR);
  const dst = join(targetRoot, name);
  const files = await diffTrees(src, dst); // side: only-central=新增, both-differ=不同, only-project=多余

  if (!files.length) {
    return { status: 'ok', skipped: true, name, path: dst, files: 0, group: null };
  }

  const exists = await pathExists(dst);
  if (exists && !force) {
    return { status: 'conflict', name, path: dst, files, count: files.length, group: null };
  }

  if (exists) await fsp.rm(dst, { recursive: true, force: true });
  await fsp.mkdir(targetRoot, { recursive: true });
  await fsp.cp(src, dst, { recursive: true, dereference: true, force: true });

  return { status: 'ok', installed: !exists, replaced: exists, name, path: dst, files: files.length, group: null };
}

// 安装内置 skill 到目标 skills 目录（默认 nx-rh → ~/.claude/skills）。
// 返回 { status: 'ok' | 'conflict', ... }——已存在且内容不同是**业务结果**，
// 需要用户决定是否覆盖，不是错误。
//
// `group` 给定时装该组的**全部** skill，返回聚合形状 { status, group, skills:[…] }；
// 不给则装单个，形状与历史一致。两者的判别靠显式 `group` 字段。
export async function installBundledSkill({ name = DEFAULT_SKILL_NAME, group, to, force } = {}) {
  if (group !== undefined && group !== null && group !== '') {
    const g = await resolveGroup(group);
    const skills = [];
    for (const s of g.skills) skills.push(await installOne(s, { to, force }));
    return {
      // 有一个冲突就是 conflict：调用方要么加 --force 要么逐个处理
      status: skills.every((r) => r.status === 'ok') ? 'ok' : 'conflict',
      group: String(group).trim(),
      skills,
    };
  }
  return installOne(name, { to, force });
}

// ─── skill get：把内置 skill 全文交给外部 agent（A03 §三） ───────────
// install 解决「本骨架的 agent 学得会用」，get 解决「外部 agent 一键拿全上下文」——
// 两者互补，不是二选一。get 永远给文档：目标端 conflict 也照常输出，
// 冲突信息放在 install 字段里让调用方自己决定要不要 --force。

// ref 解析（A03 §三）：缺省 → SKILL.md；裸名 → references/<名>.md 再 <名>.md；
// 带分隔符 → 相对 assets/<name>/；含 .. 或绝对路径一律拒绝。
async function listRefs(dir) {
  const out = [];
  const entries = await fsp.readdir(join(dir, 'references'), { withFileTypes: true }).catch(() => []);
  for (const e of entries) if (e.isFile() && e.name.endsWith('.md')) out.push(e.name.slice(0, -3));
  return out.join(', ') || '(无)';
}

async function contentOne(name, { ref, to } = {}) {
  name = assertSafeName(canonicalName(name));
  const dir = join(assetsRoot(), name);
  if (!(await pathExists(join(dir, 'SKILL.md')))) {
    const available = (await assetSkillDirs()).join(', ') || '(无)';
    throw notFound(`未找到内置 skill: ${name}（可用: ${available}）`);
  }

  let rel;
  const raw = String(ref || '').trim();
  if (!raw) {
    rel = 'SKILL.md';
  } else {
    if (raw.split(/[\\/]+/).includes('..')) throw badInput(`ref 路径不允许包含 '..': ${raw}`);
    if (/^([a-zA-Z]:|[\\/])/.test(raw)) throw badInput('ref 越界（必须是相对路径）: ' + raw);
    if (/[\\/]/.test(raw) || raw.startsWith('./')) {
      rel = raw.replace(/^\.\//, '');
    } else {
      const bare = raw.endsWith('.md') ? raw : raw + '.md';
      const inRefs = join('references', bare);
      if (await pathExists(join(dir, inRefs))) rel = inRefs;
      else if (await pathExists(join(dir, bare))) rel = bare;
      else throw badInput(`未找到 ref: ${raw}（可用: ${await listRefs(dir)}）`);
    }
  }

  const content = await fsp.readFile(join(dir, rel), 'utf8').catch(() => null);
  if (content === null) throw notFound(`skill ${name} 里没有文件: ${rel}`);

  // get 的语义是「读」不是「修」：conflict 照常返回文档，不提供 --force
  const install = await installOne(name, { to });
  return {
    skillName: name,
    // 机器契约字段统一正斜杠，Windows 上不出现反斜杠
    ref: rel.split('\\').join('/'),
    content,
    contentBytes: Buffer.byteLength(content, 'utf8'),
    install,
  };
}

// `group` 给定时把该组**每个** skill 的全文都取回来，返回 { group, skills:[…] }；
// 不给则单个。判别同样用显式 `group` 字段。
export async function bundledSkillContent({ name = DEFAULT_SKILL_NAME, group, ref, to } = {}) {
  if (group !== undefined && group !== null && group !== '') {
    const g = await resolveGroup(group);
    const skills = [];
    for (const s of g.skills) skills.push(await contentOne(s, { ref, to }));
    return { group: String(group).trim(), skills };
  }
  return contentOne(name, { ref, to });
}
