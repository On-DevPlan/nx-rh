// skill hub search：搜 skills.sh 注册表（GET /api/search），发现远程 skill 源。
//
// API 形状对齐 vercel-labs/skills src/find.ts 的 searchSkillsAPI：
//   GET {base}/api/search?q=<关键词>&limit=<N>[&owner=<o>] → { skills: [{ id, name, installs, source }] }
// 差异：find.ts 失败返空数组（交互式搜索静默容错），这里非交互、调用方要看失败原因，
// 网络/HTTP 错误抛 EXTERNAL；返回结果仍按 installs 降序。
//
// base 用 NX_RH_SKILLS_SH_URL 覆写（默认 https://skills.sh），测试指向本地夹具。
// 结果字段过 sanitize（对齐 ref src/sanitize.ts 的意图，CWE-150 终端转义注入——
// 远端数据直接进 CLI 终端与 Web 页面，控制序列必须剥掉）。
import { badInput, external } from '../../../core/errors.js';

const DEFAULT_BASE = 'https://skills.sh';
const DEFAULT_LIMIT = 20;

// 剥终端控制序列与 C0/C1 控制字符（保留 \t 与换行——描述里正常出现）。
// 正则集逐条移植自 vercel-labs/skills src/sanitize.ts（MIT）：CSI / OSC / DCS-PM-APC /
// 简单两字节转义 / C1 / 原始控制字符。防御 CWE-150：远端数据直接进 CLI 终端与 Web 页面。
const CSI_RE = /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g;
const OSC_RE = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
const DCS_PM_APC_RE = /\x1b[P^_][\s\S]*?(?:\x1b\\)/g;
const SIMPLE_ESC_RE = /\x1b[\x20-\x7e]/g;
const C1_RE = /[\x80-\x9f]/g;
const CONTROL_RE = /[\x00-\x06\x07\x08\x0b\x0c\x0d-\x1a\x1c-\x1f\x7f]/g;

export function sanitizeMeta(text) {
  return String(text ?? '')
    .replace(OSC_RE, '') // OSC 先剥（最长匹配）
    .replace(DCS_PM_APC_RE, '')
    .replace(CSI_RE, '')
    .replace(SIMPLE_ESC_RE, '')
    .replace(C1_RE, '')
    .replace(CONTROL_RE, '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 300);
}

const GITHUB_OWNER = /^[a-z0-9](?:[a-z0-9-]{0,38})$/i;

export function searchBase() {
  return (process.env.NX_RH_SKILLS_SH_URL || DEFAULT_BASE).replace(/\/+$/, '');
}

export async function searchRegistry({ query, owner, limit } = {}) {
  const q = String(query || '').trim();
  if (!q) throw badInput('用法: nx-rh skill hub search <关键词> [--owner <o>]');
  if (q.length < 2) throw badInput('关键词至少 2 个字符（过短的关键词注册表不受理）');
  if (owner && !GITHUB_OWNER.test(owner)) {
    throw badInput('--owner 必须是合法的 GitHub 组织/用户名: ' + owner);
  }
  const n = Number.parseInt(limit, 10);
  const cap = Number.isFinite(n) && n > 0 ? Math.min(n, 50) : DEFAULT_LIMIT;

  const params = new URLSearchParams({ q, limit: String(cap) });
  if (owner) params.set('owner', owner);
  const url = searchBase() + '/api/search?' + params.toString();
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json' } });
  } catch (err) {
    throw external('搜索请求失败（' + searchBase() + '）: ' + String(err.message || err).slice(0, 200));
  }
  if (!res.ok) {
    throw external('注册表返回 HTTP ' + res.status + '（' + url.slice(0, 120) + '）');
  }
  let data;
  try {
    data = await res.json();
  } catch {
    throw external('注册表返回了无法解析的内容（' + searchBase() + '）');
  }
  const rows = Array.isArray(data?.skills) ? data.skills : [];
  const results = rows
    .map((s) => ({
      name: sanitizeMeta(s.name),
      slug: sanitizeMeta(s.id),
      source: sanitizeMeta(s.source),
      installs: Number(s.installs) || 0,
    }))
    .filter((r) => r.name && r.source)
    .sort((a, b) => b.installs - a.installs);
  return { status: 'ok', query: q, owner: owner || '', base: searchBase(), results };
}
