// REST API 路由表：每条路由 = 一个 service 函数 = 一条 CLI 命令。
// 路由注册表风格参考 adminer-node 的 src/server.js。
import * as repos from '../services/repos.js';
import * as skills from '../services/skills.js';
import * as bundled from '../services/bundled.js';
import { merge3 } from '../core/diff.js';
import { storePathFromEnv } from '../core/paths.js';

const VERSION = '0.1.0';

export function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 4 * 1024 * 1024) throw new Error('请求体过大');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// [method, pattern, handler(match, query, body)]
const routes = [
  ['GET', /^\/api\/bootstrap$/, async () => {
    const settings = await skills.getSettings();
    return {
      version: VERSION,
      storePath: storePathFromEnv(),
      settings,
      adapters: skills.listAdapters(),
      repos: await repos.listRepos(),
    };
  }],

  // ---- 仓库（= CLI: nx-rh repo ...） ----
  ['GET', /^\/api\/repos$/, () => repos.listRepos()],
  ['POST', /^\/api\/repos$/, (_m, _q, b) => repos.addRepo(b)],
  ['PATCH', /^\/api\/repos\/([^/]+)$/, (m, _q, b) => repos.updateRepo(decodeURIComponent(m[1]), b)],
  ['DELETE', /^\/api\/repos\/([^/]+)$/, (m) => repos.removeRepo(decodeURIComponent(m[1]))],
  ['POST', /^\/api\/repos\/scan$/, (_m, _q, b) => repos.scanRepos(b.root, b.depth)],
  ['GET', /^\/api\/repos\/status$/, (_m, q) => repos.repoStatus(q.get('id') || undefined)],
  ['GET', /^\/api\/repos\/diff$/, (_m, q) => repos.repoDiff(q.get('id'), q.get('file') || undefined)],
  ['POST', /^\/api\/repos\/pull$/, (_m, _q, b) => repos.repoPull(b.id)],
  ['POST', /^\/api\/repos\/push$/, (_m, _q, b) => repos.repoPush(b.id)],
  ['POST', /^\/api\/repos\/resolve$/, (_m, _q, b) => repos.repoResolve(b.id, b.file, b.side)],
  ['POST', /^\/api\/repos\/open$/, (_m, _q, b) => repos.repoOpen(b.id)],

  // ---- skill（= CLI: nx-rh skill ...） ----
  ['GET', /^\/api\/skills$/, (_m, q) => skills.listSkills(q.get('side') || 'central', q.get('path') || undefined)],
  ['GET', /^\/api\/skills\/adapters$/, () => skills.listAdapters()],
  ['GET', /^\/api\/skills\/conflict$/, (_m, q) =>
    skills.skillConflict({ name: q.get('name'), project: q.get('project') })],
  ['POST', /^\/api\/skills\/sync$/, (_m, _q, b) => skills.syncSkill(b)],
  ['POST', /^\/api\/skills\/push$/, (_m, _q, b) => skills.pushSkill(b)],
  ['POST', /^\/api\/skills\/materialize$/, (_m, _q, b) => skills.materializeSkill(b)],
  ['POST', /^\/api\/skills\/apply$/, (_m, _q, b) => skills.applySkillSide(b)],

  // ---- 内置 skill 包（= CLI: nx-rh skill install ...） ----
  ['GET', /^\/api\/bundled$/, async () => ({
    defaultDir: bundled.DEFAULT_SKILLS_DIR,
    skills: await bundled.listBundledSkills(),
  })],
  ['POST', /^\/api\/bundled\/install$/, (_m, _q, b) => bundled.installBundledSkill(b)],

  // ---- 设置 ----
  ['POST', /^\/api\/settings$/, (_m, _q, b) => skills.updateSettings(b)],

  // ---- 工具原语 ----
  ['POST', /^\/api\/util\/merge$/, (_m, _q, b) => merge3(b.base, b.a, b.b, { a: b.labelA || 'ours', b: b.labelB || 'theirs' })],
];

export async function handleApi(req, res, url) {
  const method = (req.method || 'GET').toUpperCase();
  let body = {};
  if (method === 'POST' || method === 'PATCH' || method === 'PUT') {
    body = await readBody(req).catch(() => ({}));
  }
  for (const [m, re, handler] of routes) {
    if (m !== method) continue;
    const match = re.exec(url.pathname);
    if (!match) continue;
    try {
      const data = await handler(match, url.searchParams, body);
      sendJson(res, 200, { ok: true, data });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: String((err && err.message) || err) });
    }
    return;
  }
  sendJson(res, 404, { ok: false, error: '接口不存在: ' + method + ' ' + url.pathname });
}
