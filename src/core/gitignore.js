// .gitignore 纯解析：不碰文件系统——把条目解析成结构化记录，
// 「解析到哪个绝对路径」交给 modules/worktrees 的 service。
//
// 只覆盖本工具需要的子集：判定一条规则是不是「具体路径」（无 glob、非取反），
// 以便把 .gitignore 里的文件按全路径登记为扩展文件。完整的 gitignore 匹配
// 仍以 git 自身（check-ignore / ls-files）为准，这里不重复实现匹配器。

// 判断是否含未转义的 glob 元字符
function hasGlobToken(line) {
  return /(^|[^\\])[*?[]/.test(line);
}

// 返回条目数组：
//   { raw, negated, dirOnly, rootAnchored, hasGlob, segments, path }
export function parseGitignore(text) {
  const entries = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const negated = line.startsWith('!');
    if (negated) line = line.slice(1);

    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);

    const leadingSlash = line.startsWith('/');
    if (leadingSlash) line = line.slice(1);

    const glob = hasGlobToken(line);
    // 去掉转义符（\# \* 等）
    const clean = line.replace(/\\(.)/g, '$1');
    const segments = clean.split(/\/+/).filter(Boolean);

    entries.push({
      raw: rawLine,
      negated,
      dirOnly,
      // 前导斜杠或内含斜杠都表示锚定到 .gitignore 所在目录
      rootAnchored: leadingSlash || clean.includes('/'),
      hasGlob: glob,
      segments,
      path: segments.join('/'),
    });
  }
  return entries;
}

// 可直接落全路径的条目：非取反、无 glob、有路径
export function concreteEntries(entries) {
  return entries.filter((e) => !e.negated && !e.hasGlob && e.path);
}

// 归一的对比键：判断某条 ignore 记录是否已登记（忽略前后斜杠差异）
export const ignoreKey = (p) => String(p || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
