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
const ASSETS_DIR = fileURLToPath(new URL('../../../assets/', import.meta.url));

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

async function pathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export function assetsDir() {
  return ASSETS_DIR;
}

// 列出包内自带的所有 skill（含文件数与描述）
export async function listBundledSkills() {
  const out = [];
  const entries = await fsp.readdir(ASSETS_DIR, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = join(ASSETS_DIR, e.name);
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

// 安装内置 skill 到目标 skills 目录（默认 nx-rh → ~/.claude/skills）
// 返回 { status: 'ok' | 'conflict', ... }——已存在且内容不同是**业务结果**，
// 需要用户决定是否覆盖，不是错误。
export async function installBundledSkill({ name = DEFAULT_SKILL_NAME, to, force } = {}) {
  name = assertSafeName(canonicalName(name));
  const src = join(ASSETS_DIR, name);
  if (!(await pathExists(join(src, 'SKILL.md')))) {
    const available = (await listBundledSkills()).map((s) => s.name).join(', ') || '(无)';
    throw notFound(`未找到内置 skill: ${name}（可用: ${available}）`);
  }

  const targetRoot = resolve(to || DEFAULT_SKILLS_DIR);
  const dst = join(targetRoot, name);
  const files = await diffTrees(src, dst); // side: only-central=新增, both-differ=不同, only-project=多余

  if (!files.length) {
    return { status: 'ok', skipped: true, name, path: dst, files: 0 };
  }

  const exists = await pathExists(dst);
  if (exists && !force) {
    return { status: 'conflict', name, path: dst, files, count: files.length };
  }

  if (exists) await fsp.rm(dst, { recursive: true, force: true });
  await fsp.mkdir(targetRoot, { recursive: true });
  await fsp.cp(src, dst, { recursive: true, dereference: true, force: true });

  return { status: 'ok', installed: !exists, replaced: exists, name, path: dst, files: files.length };
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

export async function bundledSkillContent({ name = DEFAULT_SKILL_NAME, ref, to } = {}) {
  name = assertSafeName(canonicalName(name));
  const dir = join(ASSETS_DIR, name);
  if (!(await pathExists(join(dir, 'SKILL.md')))) {
    const available = (await listBundledSkills()).map((s) => s.name).join(', ') || '(无)';
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
  const install = await installBundledSkill({ name, to });
  return {
    skillName: name,
    // 机器契约字段统一正斜杠，Windows 上不出现反斜杠
    ref: rel.split('\\').join('/'),
    content,
    contentBytes: Buffer.byteLength(content, 'utf8'),
    install,
  };
}
