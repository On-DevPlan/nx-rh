// Markdown 结构抽取：前 N 级标题 + 规模统计。
// 纯函数、零业务语义——服务层与测试都用它（A01：纯算法放 core）。

// 抽取 1..maxLevel 级 ATX 标题（#{1,6} 开头）。
// 代码围栏（``` / ~~~）里的 # 不是标题：进围栏后跳过，直到同级围栏闭合。
// 返回 [{ level, text, line }]，line 从 1 起（供面板/编辑器定位）。
export function mdOutline(text, maxLevel = 3) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  let fence = '';
  lines.forEach((line, i) => {
    const f = line.match(/^\s*(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = '';
      return;
    }
    if (fence) return;
    const m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (m && m[1].length <= maxLevel) {
      out.push({ level: m[1].length, text: m[2].trim(), line: i + 1 });
    }
  });
  return out;
}

// 规模：行数 / 字节数 / 标题节总数。给「这个 skill 有多大」的一眼判断。
export function mdStats(text, outline) {
  const t = String(text || '');
  return {
    lines: t ? t.split(/\r?\n/).length : 0,
    bytes: Buffer.byteLength(t, 'utf8'),
    sections: Array.isArray(outline) ? outline.length : 0,
  };
}
