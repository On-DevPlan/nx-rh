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

// 订阅源根目录的探测：可能直接是 skill、包一层 skills/、带类目层级
// （skills/<类目>/<name>/）、或由 .claude-plugin 清单声明路径（Claude 插件市场布局）。
// 深层探测对齐 vercel-labs/skills 的发现规则（其 src/skills.ts）：容器目录向下最多
// 3 层、遇 SKILL.md 即停（浅层遮蔽深层）；清单声明的路径不受层数限制。
export async function resolveSkillsRoot(sourcePath) {
  const direct = await countSkillDirs(sourcePath);
  if (direct > 0) return sourcePath;
  const nested = join(sourcePath, 'skills');
  if (await countSkillDirs(nested)) return nested;
  // 两层类目（skills/<类目>/<name>/SKILL.md）与更深的布局：skills/ 里没有
  // 一级 skill 时再向下探一层，命中即把 skills/ 当根（扫描器随后递归发现）。
  if (await hasDeepSkill(nested, 1)) return nested;
  return sourcePath; // 空源：仍返回自身，便于报「0 个 skill」
}

// 目录（或其清单声明）里是否**存在** skill——用于根探测。
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
  if (n) return n;
  return (await collectContainerSkills(root, 3)).length;
}

// 只想知道「这个容器里有没有 skill」（不收集 skill 本体）。
async function hasDeepSkill(root, depth) {
  return (await collectContainerSkills(root, depth)).length > 0;
}

// 收集容器里的 skill 目录（hasSkillMd 判定版，供根探测用——不解析 frontmatter）。
async function collectContainerSkills(root, maxDepth) {
  const found = [];
  async function walk(dir, left) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.name || e.name.startsWith('.')) continue;
      const child = join(dir, e.name);
      const lst = await fsp.lstat(child).catch(() => null);
      if (!lst || lst.isSymbolicLink() || !lst.isDirectory()) continue;
      if (await exists(join(child, 'SKILL.md'))) {
        found.push(child);
        continue;
      }
      if (left <= 1) continue;
      await walk(child, left - 1);
    }
  }
  await walk(root, maxDepth);
  return found;
}

// 扫描一个 skills 根目录下的一级子目录（每个即一个 skill）。
//
// realOnly（来源侧恒为 true）：只认实文件。源目录里的链接是**别的真相源**的落地副本
// （典型：把 ~/.claude/skills 订阅为临时来源，里面大半是指向 sl 的链接）——
// 把它们当来源会造成「同名 skill 出现在多个源」的假冲突，而且违背
// 「唯一实文件 = 订阅源」：链接本来就不是实文件。
// 目标侧（realOnly=false）则照常识别链接形态，那是迁移的结果。
//
// 来源侧递归发现（对齐 vercel-labs/skills 的规则）：一级没有 SKILL.md 的子目录
// 继续向下走（最多 3 层，遇 skill 即停）——覆盖 skills/<类目>/<name>/ 类目布局
// 与 .claude-plugin/marketplace.json 声明的任意深度路径。目标侧不递归：
// 迁移产物本来就是平铺的一级目录。
export async function scanSkillsRoot(root, { source, realOnly } = {}) {
  const out = [];
  const seen = new Set();
  const push = async (dir) => {
    const info = await readSkill(dir);
    if (!info) return false;
    if (realOnly && info.linkType) return true; // 是 skill 但是链接 → 来源侧跳过
    if (source) info.source = source;
    out.push(info);
    return true;
  };

  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.name || e.name.startsWith('.')) continue;
    const dir = join(root, e.name);
    const lst = await fsp.lstat(dir).catch(() => null);
    if (!lst) continue;
    if (!lst.isDirectory() && !lst.isSymbolicLink()) continue;
    if (await push(dir)) { seen.add(e.name); continue; }
    if (realOnly) {
      // 来源侧：一级不是 skill 就按容器目录向下走（对齐 vercel-labs/skills
      // src/skills.ts 的 walkSkillDirs）：先试子项、是 skill 即停（浅层遮蔽）、
      // 容器最多走 3 层——skills/<类目>/<类目>/<name>/SKILL.md 可达。
      await walkContainer(dir, 3, push, seen);
      continue;
    }
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
  // plugin 清单声明的路径（可能不在 skills/ 约定目录里、也可能超出 3 层）
  if (realOnly) {
    for (const found of await discoverManifestSkillDirs(root)) {
      const rel = basename(found);
      if (seen.has(rel)) continue;
      if (await push(found)) seen.add(rel);
    }
  }
  return out;
}

// 容器目录走查（逐字对齐 vercel-labs/skills src/skills.ts 的 walkSkillDirs）：
// 先试 dir 的每个子项是不是 skill；是即收（不再深入——浅层遮蔽），不是且还有
// 层数就继续向下。maxDepth 是**容器自身**允许走的层数（子项为第 1 层）。
async function walkContainer(dir, maxDepth, push, seen) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.name || e.name.startsWith('.')) continue;
    const child = join(dir, e.name);
    const lst = await fsp.lstat(child).catch(() => null);
    if (!lst || lst.isSymbolicLink() || !lst.isDirectory()) continue;
    if (seen.has(e.name)) continue;
    if (await push(child)) { seen.add(e.name); continue; }
    if (maxDepth <= 1) continue;
    await walkContainer(child, maxDepth - 1, push, seen);
  }
}

// .claude-plugin 清单（Claude 插件市场布局，参考 vercel-labs/skills src/plugin-manifest.ts）：
//   marketplace.json: { metadata: { pluginRoot }, plugins: [{ name, source, skills: [路径...] }] }
//   plugin.json:      { skills: [路径...] }
// 声明的 skill 路径不受 3 层限制；解析失败的清单安静跳过（清单只是补充，不是门槛）。
async function discoverManifestSkillDirs(root) {
  const out = [];
  const addDir = async (base, rel) => {
    if (!rel || typeof rel !== 'string') return;
    const norm = rel.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+$/, '');
    if (!norm || norm.split('/').includes('..')) return; // 穿越段直接无视
    const dir = join(root, base, norm);
    if (await exists(join(dir, 'SKILL.md'))) out.push(dir);
  };

  const readJson = async (p) => JSON.parse(await fsp.readFile(p, 'utf8').catch(() => 'null'));

  // marketplace.json
  const mkt = await readJson(join(root, '.claude-plugin', 'marketplace.json'));
  if (mkt && typeof mkt === 'object') {
    const pluginRoot = String(mkt?.metadata?.pluginRoot || '.');
    for (const p of Array.isArray(mkt.plugins) ? mkt.plugins : []) {
      if (!p || typeof p !== 'object') continue;
      for (const s of Array.isArray(p.skills) ? p.skills : []) await addDir(pluginRoot, s);
    }
  }
  // plugin.json（单插件仓库）
  const plugin = await readJson(join(root, '.claude-plugin', 'plugin.json'));
  if (plugin && typeof plugin === 'object') {
    for (const s of Array.isArray(plugin.skills) ? plugin.skills : []) await addDir('.', s);
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

// 一个 skills 根目录的快照：{ [skill名]: 目录指纹 }。由 skill hub refresh 落盘进
// store.sourceSnapshots[sourcePath]，下次 refresh 前后对比即得 新增/移除/变更。
export async function snapshotSkills(dir) {
  const root = await resolveSkillsRoot(dir);
  const skills = await scanSkillsRoot(root, { realOnly: true });
  const out = {};
  for (const s of skills) out[s.name] = await skillDirHash(join(root, s.name));
  return out;
}
