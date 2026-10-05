// 设置页：通用信息（存储位置 / 启动目录 / 端口 / 适配器目录表）。
// Skill 域的设置（订阅源 / 项目候选 / 平台范围 / 默认平台 / 迁移形态）已整体迁入
// Skill 页的「Skill 设置」弹窗（src/modules/skills/parts/dialogs.jsx）——
// 这些项只在 Skill 页里被用到，就地可改才是它们的场景；两处并存只会漂移。
import { useStore } from '../../web/frontend/store.jsx';
import { Copyable } from '../../web/frontend/components/ui.jsx';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';

export default function SettingsView() {
  const { boot } = useStore();
  const adapters = boot?.adapters || [];

  return (
    <>
      <div className="page-head">
        <div className="title-block">
          <h2>设置</h2>
          <div className="page-desc">
            通用信息：存储位置、启动目录、适配器目录表。Skill 域的订阅源 / 平台 / 迁移形态在
            Skill 页右上角「Skill 设置」里管理。
          </div>
        </div>
      </div>

      <div className="card">
        <div className="colhead"><h3>通用</h3></div>
        <div className="settings">
          <dt>存储文件</dt><dd className="mono"><Copyable text={boot?.appStorePath}>{boot?.appStorePath}</Copyable></dd>
          <dt>启动目录</dt><dd className="mono"><Copyable text={boot?.projectRoot}>{boot?.projectRoot}</Copyable></dd>
          <dt>面板端口</dt><dd>默认 7800（<code>nx-rh serve --port</code> 可改，仅绑定 127.0.0.1）</dd>
          <dt>适配器目录</dt>
          <dd>{adapters.map((a) => (
            <Copyable key={a.id} className="adapter-dir mono" text={a.dir} title={`点击复制 ${a.id} 项目级目录`}>
              {a.id} = {a.dir}
            </Copyable>
          ))}</dd>
        </div>
      </div>

      <CliHints module="settings" />
    </>
  );
}
