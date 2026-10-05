// Skill 模块的 hash 路由：解析与页面间跳转。纯函数，无 react、无 node:*。
export function parseRoute() {
  const h = (location.hash || '').replace(/^#\/?/, '');
  const parts = h.split('/');
  const level = parts[1] || 'overview';
  const arg = parts[2] ? decodeURIComponent(parts[2]) : '';
  return { level, arg };
}

export const goOverview = () => { location.hash = '#/skills'; };
export const goPlatform = (id) => { location.hash = `#/skills/platform/${id}`; };
export const goHub = (path) => { location.hash = `#/skills/hub/${encodeURIComponent(path)}`; };
export const goProject = () => { location.hash = '#/skills/project'; };
export const goSkill = (name) => { location.hash = `#/skills/skill/${encodeURIComponent(name)}`; };
