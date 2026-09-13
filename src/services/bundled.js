// 内置 skill 包：随 nx-rh 一起发布的 assets/<name>/（SKILL.md + references/…）
// 负责列出与安装到用户/项目的 skills 目录，供 agent 一键获得 nx-rh 的使用说明。
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fsp from 'node:fs/promises';
import { diffTrees } from './skills.js';

// assets/ 在包根，src/services/ 的上两级
const ASSETS_DIR = fileURLToPath(new URL('../../assets/', import.meta.url));

// 默认安装到 Claude Code 的用户级 skills 目录
export const DEFAULT_SKILLS_DIR = join(homedir(), '.claude', 'skills');

function assertSafeName(name) {
  if (!name || typeof name !== 'string' || /[\\/]/.test(name) || name.includes('..') || name.startsWith('.')) {
    throw new Error('非法 skill 名称: ' + name);
  }
  return name;
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
    const files = await diffTrees(dir, join(dir, '__nx_rh_missing__'));
    if (!files.length) continue;
    let description = '';
    const md = await fsp.readFile(join(dir, 'SKILL.md'), 'utf8').catch(() => null);
    if (md) {
      const m = /^---[ \t]*\n([\s\S]*?)\n---/m.exec(md.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'));
      if (m) {
        const dm = /^description:[ \t]*(.+)$/m.exec(m[1]);
        if (dm) description = dm[1].trim().replace(/^["']|["']$/g, '');
      }
    }
    out.push({ name: e.name, dir, files: files.length, description });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// 安装内置 skill 到目标 skills 目录（默认 ~/.claude/skills）
export async function installBundledSkill({ name = 'repo-hub', to, force } = {}) {
  name = assertSafeName(name);
  const src = join(ASSETS_DIR, name);
  if (!(await pathExists(join(src, 'SKILL.md')))) {
    const available = (await listBundledSkills()).map((s) => s.name).join(', ') || '(无)';
    throw new Error(`未找到内置 skill: ${name}（可用: ${available}）`);
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
