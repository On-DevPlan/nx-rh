// API 客户端：全部面板操作走 /api，与 CLI 共享同一 service 层。
// 约定响应包 { ok, data | error }；失败抛 Error，交给调用方 toast。

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let json;
  try { json = await res.json(); } catch { throw new Error('HTTP ' + res.status); }
  if (!json.ok) throw new Error(json.error || '请求失败');
  return json.data;
}
