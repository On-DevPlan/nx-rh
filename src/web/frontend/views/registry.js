// 视图注册表：新增一个面板 = 在 views/ 下写一个组件 + 在这里登记一行。
// App 的 tab 导航、hash 路由、懒加载全部由这张表驱动，改面板不再需要动壳。
import { lazy } from 'react';

export const VIEWS = [
  { id: 'repos', title: '仓库', component: lazy(() => import('../views/reposView.jsx')) },
  { id: 'skills', title: 'Skill', component: lazy(() => import('../views/skillsView.jsx')) },
  { id: 'github', title: 'GitHub', component: lazy(() => import('../views/githubView.jsx')) },
  { id: 'settings', title: '设置', component: lazy(() => import('../views/settingsView.jsx')) },
];
