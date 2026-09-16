// SKILL.md frontmatter 解析（与 fileops.go / gitimporter.go 同语义，另修 CRLF）。
//
// 关键点：Windows 上 SKILL.md 通常是 CRLF，必须先归一化换行再逐行解析，
// 否则 JS 正则的 `$`（非 multiline）无法匹配行尾残留的 \r，name/description 会全部丢失。
//
// 只解析 name / description 两个字段——不引入 YAML 依赖，手写够用的子集：
// 单行值、成对引号值、| / > 块标量、缩进续行。

// 返回 { name, description }；无 frontmatter 或字段缺失时为空串（调用方自行兜底）
export function parseFrontmatter(raw) {
  // 去 BOM：用 charCodeAt 判定而非正则字面量，避免源码里出现不可见的 BOM 字符
  let content = String(raw ?? '');
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  content = content.replace(/\r\n?/g, '\n');
  const m = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(\n|$)/.exec(content);
  if (!m) return { name: '', description: '' };
  const lines = m[1].split('\n');
  return {
    name: readField(lines, 'name').trim(),
    description: readField(lines, 'description').trim(),
  };
}

// 去掉包裹的成对引号
function unquote(v) {
  const s = v.trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1).trim();
  }
  return s;
}

// 读取 frontmatter 字段：支持单行值、引号值、| / > 块标量、以及缩进续行
function readField(lines, key) {
  const re = new RegExp('^' + key + ':[ \\t]*(.*)$');
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    const rawVal = m[1].trim();
    const isBlock = /^[|>][-+]?$/.test(rawVal);
    if (!isBlock && rawVal !== '') return unquote(rawVal);

    // 块标量或空值：收集后续缩进行（YAML 多行标量）
    const block = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === '') {
        block.push('');
        continue;
      }
      if (!/^[ \t]/.test(l)) break;
      block.push(stripIndent(l));
    }
    const text = block.join('\n').trim();
    if (text) return rawVal.startsWith('>') ? text.replace(/\s*\n\s*/g, ' ').trim() : text;
    return unquote(rawVal);
  }
  return '';
}

function stripIndent(l) {
  if (l.startsWith('  ')) return l.slice(2);
  if (l.startsWith('\t')) return l.slice(1);
  return l.replace(/^[ \t]+/, '');
}
