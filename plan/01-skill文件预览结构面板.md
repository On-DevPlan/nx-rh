# 01 Skill 文件预览：MD 结构快速预览小面板（P2）

来源：KV 任务「对于 skill 的文件预览，提供 md 的前三级标题的快速预览，提供小面板，
方便快速预览 skill 或者 ref 的结构」。

## 现状

Skill 详情页（`modules/skills/parts/SkillDetail.jsx`）的文件预览 `SkillFiles`
是「左文件树 / 右内容」：点 ref 文件 → `/api/skills/content` 拉全文塞进 `<pre>`。
后端在这条响应里**已经返回** `outline`（`core/mdoutline.js` 的 `mdOutline(content, 3)`，
围栏感知、带行号，单测已钉）——前端拿到就丢了，结构只能靠滚。

## 处理意图

内容右缘加一条**结构小面板**（VS Code Outline 同位型）：当前文件是 .md 且抽得出
标题时显示，前三级按层级缩进、带行号；点条目跳到正文对应行并短暂高亮。
非 .md 文件 / 无标题 → 面板不出现，版面与现在一致。

- 正文改为按行渲染（每行一个带 id 的 span），跳转 = `scrollIntoView` 到行 +
  目标行短暂着色；复制语义不变（行尾换行保留在 span 内）。
- 数据零新增接口：`content` 响应里的 `outline` 直接用。

## 改动

- `modules/skills/parts/SkillDetail.jsx`：SkillFiles 收 outline、按行渲染正文、
  结构面板与跳转。
- `web/frontend/style.css`：`.skl-files.has-outline` 三栏、`.skl-outline` 及条目样式、
  行高亮、窄屏降级（面板排到内容下方）。

## 验收

- [ ] SKILL.md / ref 的 .md 显示三级结构面板；点条目跳行 + 高亮
- [ ] 非 md 文件不显示面板；无标题的 md 也不显示
- [ ] 窄屏（<860px）面板排在内容下方不破版
- [ ] `pnpm test`（nx-rh）全绿
