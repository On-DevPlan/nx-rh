// Web 服务器：node:http 零依赖。
// 职责仅两件事：静态面板文件 + /api/* JSON 路由（路由表在 api.js）。
import http from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fsp from 'node:fs/promises';
import { handleApi, sendJson } from './api.js';
import { DEFAULT_PORT } from '../core/paths.js';

const PUBLIC_DIR = fileURLToPath(new URL('public/', import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

async function serveStatic(pathname, res) {
  let p = pathname === '/' ? '/index.html' : pathname;
  // 防目录穿越：剥离相对片段
  p = p.replace(/(\.\.|%2e%2e)/gi, '');
  const file = join(PUBLIC_DIR, p);
  try {
    const buf = await fsp.readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
}

export function startServer({ port = DEFAULT_PORT, host = '127.0.0.1' } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
        return;
      }
      await serveStatic(url.pathname, res);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String((err && err.message) || err) });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
