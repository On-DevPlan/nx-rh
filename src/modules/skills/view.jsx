// Skill 模块（三级结构 + 项目子页）：
//   ① 总览 #/skills            订阅源入口 + 当前项目入口 + 全部平台入口 + 快捷设置
//   ② 子页 #/skills/platform/<id> · #/skills/hub/<encoded path> · #/skills/project
//                               该平台 / 订阅源 / 当前项目目录下的 skill 卡片网格
//   ③ 详情 #/skills/skill/<name>  平台安装状态 + 迁移 / 提交 / 删除，文件预览收在最后
//
// 模型不变：订阅源（唯一可信源）→ 平台目录（迁移）；平台 → 订阅源（提交收进）。
// 不在订阅源的 skill 走「收进订阅源（submit）→ 目标改回软链接」的中心化动作集。
//
// 本文件只是路由分发 + 全局编辑弹窗；页面组件在 parts/ 下
// （布局约定见 README「模块内的文件布局与何时拆」）。
// view.jsx 保持 web/frontend/registry.js 的懒加载 chunk 唯一入口，parts 静态并入同一 chunk。
import { useEffect, useState } from 'react';
import { useStore } from '../../web/frontend/store.jsx';
import { Modal } from '../../web/frontend/components/ui.jsx';
import { useSkillsData } from './parts/shared.jsx';
import { parseRoute } from './parts/routes.js';
import { Overview } from './parts/Overview.jsx';
import { PlatformPage } from './parts/PlatformPage.jsx';
import { HubPage } from './parts/HubPage.jsx';
import { ProjectPage } from './parts/ProjectPage.jsx';
import { SkillDetail } from './parts/SkillDetail.jsx';
import { SkillEditor } from './parts/dialogs.jsx';

// ─── 模块入口：路由分发 + 全局编辑弹窗 ───────────────────────────────

export default function SkillsView() {
  const [route, setRoute] = useState(parseRoute);
  const [tick, setTick] = useState(0);
  const { ui, patchUi } = useStore();

  useEffect(() => {
    const onHash = () => { setRoute(parseRoute()); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // 总览需要一份默认数据
  const overview = useSkillsData({}, tick);

  const bump = () => setTick((t) => t + 1);

  const openCreate = () => patchUi({ editor: { mode: 'create' } });
  const editor = ui.editor;
  const closeEditor = () => patchUi({ editor: null });

  let body;
  if (route.level === 'platform') {
    body = <PlatformPage platformId={route.arg} tick={tick} />;
  } else if (route.level === 'hub') {
    body = <HubPage hubPath={route.arg} tick={tick} />;
  } else if (route.level === 'project') {
    body = <ProjectPage tick={tick} />;
  } else if (route.level === 'skill') {
    body = <SkillDetail name={route.arg} tick={tick} />;
  } else {
    body = <Overview data={overview.data} openCreate={openCreate} />;
  }

  return (
    <>
      {body}
      {editor ? (
        <Modal title={editor.mode === 'edit' ? `编辑 skill · ${editor.skill?.name}` : '新建 skill'} onClose={closeEditor}>
          <SkillEditor
            mode={editor.mode}
            skill={editor.skill || {}}
            close={closeEditor}
            reload={async () => { bump(); }}
          />
        </Modal>
      ) : null}
    </>
  );
}
