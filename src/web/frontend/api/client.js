// API 客户端：全部面板操作走 /api，与 CLI 共享同一份 action 声明。
//
// 响应包约定 { ok: true, data } / { ok: false, error, code }。
// 失败时抛 Error 并带上 .code —— 调用方可据此区分「业务冲突」与「参数错误」，
// 而不是像改造前那样只能对错误文案做字符串匹配。
const DEFAULT_TIMEOUT_MS = 30000;

// 作用域：面板当前选中的项目目录。每次请求自动带上 x-nx-rh-scope 头，
// 服务端据此激活 AsyncLocalStorage 作用域——业务 action 完全不感知「切项目」。
// 放在模块级而不是每次调用传参：只要 UI 改了项目，之后所有请求自动跟随。
let activeScope = '';

export function setActiveScope(dir) {
  activeScope = dir || '';
}

export async function api(path, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || DEFAULT_TIMEOUT_MS);

  try {
    const headers = {};
    if (opts.body) headers['content-type'] = 'application/json';
    if (activeScope) headers['x-nx-rh-scope'] = activeScope;

    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: Object.keys(headers).length ? headers : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal,
    });
    let json;
    try {
      json = await res.json();
    } catch {
      throw new Error(`HTTP ${res.status}`);
    }
    if (!json.ok) {
      const err = new Error(json.error || '请求失败');
      err.code = json.code;
      err.details = json.details;
      throw err;
    }
    return json.data;
  } catch (e) {
    // AbortError 的原生文案是「The operation was aborted」，对用户没有意义
    if (e && e.name === 'AbortError') throw new Error('请求超时（本地服务无响应）');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
