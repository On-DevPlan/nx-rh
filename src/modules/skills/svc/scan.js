// skill 目录的扫描与读取：所有上层（sources / queries / transfer）共用的叶下层。
// 来源只认**实文件**，目标侧照常识别链接形态——这条规则决定谁是真相源。
import { basename, join } from 'node:path';
import fsp from 'node:fs/promises';
import { exists, md5Of, walkFiles } from '../../../core/fstree.js';
import { parseFrontmatter } from '../../../core/frontmatter.js';
import { detectLinkType } from '../../../core/link.js';

export async function readSkill(dir) {
  const mdPath = join(dir, 'SKILL.md');
  const raw = await fsp.readFile(mdPath, 'utf8').catch(() => null);
  if (raw === null) return null;
  const fm = parseFrontmatter(raw);
  const st = await fsp.stat(mdPath).catch(() => null);
  return {
    name: fm.name || basename(dir),
    description: fm.description || '(无描述)',
    dir,
    md5: md5Of(Buffer.from(raw, 'utf8')),
    lastModified: st ? st.mtime.toISOString() : '',
    linkType: await detectLinkType(dir),
  };
}

// 订阅源目录里可能直接是 skill，也可能包一层 skills/。逐个探测：
// 先看目录本身是否含 skill 子目录，否则退回 <dir>/skills。
export async function resolveSkillsRoot(sourcePath) {
  const direct = await countSkillDirs(sourcePath);
  if (direct > 0) return sourcePath;
  const nested = join(sourcePath, 'skills');
  if (await countSkillDirs(nested)) return nested;
  return sourcePath; // 空源：仍返回自身，便于报「0 个 skill」
}

async function countSkillDirs(root) {
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  let n = 0;
  for (const e of entries) {
    if (!e.name || e.name.startsWith('.')) continue;
    // 来源只认**实文件**：链接是别的真相源的落地副本，不算来源
    const lst = await fsp.lstat(join(root, e.name)).catch(() => null);
    if (!lst || lst.isSymbolicLink() || !lst.isDirectory()) continue;
    if (await exists(join(root, e.name, 'SKILL.md'))) n++;
  }
  return n;
}

// 扫描一个 skills 根目录下的一级子目录（每个即一个 skill）。
//
// realOnly（来源侧恒为 true）：只认实文件。源目录里的链接是**别的真相源**的落地副本
// （典型：把 ~/.claude/skills 订阅为临时来源，里面大半是指向 sl 的链接）——
// 把它们当来源会造成「同名 skill 出现在多个源」的假冲突，而且违背
// 「唯一实文件 = 订阅源」：链接本来就不是实文件。
// 目标侧（realOnly=false）则照常识别链接形态，那是迁移的结果。
export async function scanSkillsRoot(root, { source, realOnly } = {}) {
  const out = [];
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.name || e.name.startsWith('.')) continue;
    const dir = join(root, e.name);
    const lst = await fsp.lstat(dir).catch(() => null);
    if (!lst) continue;
    if (!lst.isDirectory() && !lst.isSymbolicLink()) continue;
    const info = await readSkill(dir);
    if (info) {
      if (realOnly && info.linkType) continue;
      if (source) info.source = source;
      out.push(info);
      continue;
    }
    if (realOnly) continue; // 悬空链接在来源侧是噪音，不是 skill
    const lt = lst.isSymbolicLink() ? 'symlink' : await detectLinkType(dir);
    if (lt) {
      out.push({
        name: e.name,
        description: '(链接目标缺失，可清理)',
        dir,
        md5: '',
        lastModified: '',
        linkType: lt,
        source,
      });
    }
  }
  return out;
}

// ─── 目录内容指纹（sync 的变更判定基础） ──────────────────────────────
// 思路对齐 vercel-labs/skills 的 skill-lock.ts tree SHA：目录里**任何文件**变了，
// 指纹就变。本地实现用「排序后的 相对路径\0文件md5 行拼接 → 整体 md5」——
// 不依赖 git，对 clone 与下载两种落地形态一视同仁。
export async function skillDirHash(dir) {
  const files = await walkFiles(dir);
  const lines = [...files.entries()].map(([rel, f]) => rel + '\0' + f.md5).sort();
  return md5Of(Buffer.from(lines.join('\n'), 'utf8'));
}

// 一个 skills 根目录的快照：{ [skill名]: 目录指纹 }。subscribe / sync 落盘进
// store.remoteSources[path].skills，下次拉取前后对比即得 新增/移除/变更。
export async function snapshotSkills(dir) {
  const root = await resolveSkillsRoot(dir);
  const skills = await scanSkillsRoot(root, { realOnly: true });
  const out = {};
  for (const s of skills) out[s.name] = await skillDirHash(join(root, s.name));
  return out;
}
