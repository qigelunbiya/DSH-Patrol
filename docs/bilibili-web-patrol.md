# Bilibili 网页端巡检操作手册

本文用于 DSH Patrol 在 Bilibili 网页端进行首页选视频、进入详情、点赞、评论、读取简介等巡检操作。它记录稳定的业务策略，不绑定某一版 Bilibili 的易变 CSS class。

## 1. 浏览器操作方式由用户决定

页面动作有三种策略，优先级以用户当前任务中的明确要求为准：

1. **用户未指定方式**：使用默认 AUTO/HYBRID。根据 CURRENT 页面证据在 DOM/semantic、稳定 selector、视觉之间选择最可靠的方法，不规定“必须先 DOM”或“必须先视觉”。
2. **用户明确要求只用视觉模型**：必须先 `patrol_observe(includeImage=true)`，确认输出包含 `MODEL-VISIBLE image attached`、`visualClickReady=true` 和新的 `visualFrameId`。随后使用 `patrol_visual_click_target(..., visualAuthority=true)`。业务点击不能偷偷改用 DOM/semantic 来完成；DOM 只可在点击后用于命中身份学习和结果验证。
3. **用户明确禁止视觉**：不得调用 `patrol_observe(includeImage=true)`、`patrol_visual_click_target` 或猜测截图坐标。使用 `patrol_observe(includeImage=false)`、`patrol_snapshot`、`patrol_read_page`、`patrol_click_target` 等非视觉证据完成。

普通图片字符验证码属于专用认证流程，继续走 Patrol 的本地/Windows OCR solver；不要把通用“视觉专用”页面策略套到验证码识别上。

## 2. 首页选择非广告视频

目标是选择一个真实视频卡片，而不是广告、投稿入口、频道导航或其它碰巧包含视频路径字样的链接。

- 先读取 CURRENT 首页，识别明确带“广告”、推广、商业推荐等标记的卡片并排除。
- 选中候选视频后，**先保存它在首页上看到的完整标题**，再点击。
- DOM 策略优先使用“完整标题 + 当前卡片上下文”做唯一定位；不要使用过宽的“任意包含 /video/ 的链接”、第一个链接、或第一个标题节点等选择器。
- 视觉策略必须把首页截图里实际看见的完整视频标题放入 `expectedVisualText`，点击标题/封面所在同一卡片的可点击区域。
- 如果点击打开新标签页，Patrol 应采用该新标签页作为 CURRENT 页面，而不是继续把源首页当成详情页。

### 进入详情后的强校验

点击后不能只凭 URL 发生变化就算成功。至少核对：

- 详情页主标题与首页记录的标题一致或规范化后一致；
- URL 是真实 Bilibili 视频详情页（通常含 BV 标识），而不是投稿页、广告落地页或其它业务页；
- 若标题不一致，立即把本次点击标记为未验证，返回首页重新定位，**不要继续点赞或评论错误视频**。

## 3. 点赞

Bilibili 的点赞属于 toggle 动作，误点两次会恢复原状态。

- 点击前尽量读取当前点赞状态；若已有激活/已点赞证据，不要再次点击。
- 只允许一次经过验证的物理点击。
- 点击后验证按钮状态、ARIA/类状态、计数变化或其它 CURRENT 状态证据；只有“工具发出 click”不能算成功。
- 已验证成功后禁止为了“确认一下”再点一次。

## 4. 评论区与发送评论

评论区可能懒加载，也可能由 WebComponent/Shadow DOM 渲染。

- 向下滚动后必须重新获取 CURRENT 证据；旧截图的坐标在滚动后作废。
- “评论”“尊重是评论打动人心的入场券”等文字只证明评论区域附近存在，不等于已经找到可编辑输入框。
- DOM 可直接识别 textarea/contenteditable 时，使用公开文本输入工具。
- 视觉点击已经可靠聚焦评论编辑器、但编辑器随后挂载到 Shadow DOM 时，可使用 `patrol_type_focused_text` 向当前真实焦点输入公开评论文本。
- 发送前确认编辑器中出现了用户要求的完整文本；发送后确认评论列表或发送状态发生变化。
- “发布/发送”按钮必须和当前评论编辑器处在同一局部上下文，不能点击页面其它同名按钮。

## 5. 读取视频简介

- 从 CURRENT 视频详情页读取 UP 主发布的视频简介/描述区域。
- 不要把评论、推荐视频文案、UP 主个人简介、播放器弹幕或页面导航文字当成视频简介。
- 简介折叠时可以先展开再读取；如果页面确实没有视频简介，按业务任务约定使用兜底文本，例如“收到”。
- 后续跨应用发送时，只发送最终提取出的简介文本或兜底文本，不混入 Patrol 调试信息。

## 6. 视觉截图可靠性

`patrol_observe(includeImage=true)` 返回的图片必须是真正进入模型上下文的 CURRENT 截图。

- 看到 `MODEL-VISIBLE image attached` 和 `Visual click frame READY` 后才能计算 `xRatio/yRatio`。
- 页面发生滚动、缩放、跳转、标签页切换或显著布局变化后，旧 `visualFrameId` 立即视为过期，应重新观察。
- 扩展会把高 DPR 的截图限制在 Patrol 的模型栅格预算内。若 CDP 压缩或页面 MAIN-world canvas 不可用，扩展 service worker 会使用 OffscreenCanvas 做最终降采样；上层仍会以 `read_image` 实际宽度为最终安全检查。
- 若图片没有成功附加，不得根据 OCR/DOM 文本假装自己“看到了截图”，更不能猜坐标。

## 7. 教学与 Runbook

最终保存的 Runbook 只保留完成业务目标的验证成功路径：

- 首页选中正确视频；
- 详情标题校验；
- 点赞成功；
- 评论输入与发送成功；
- 读取简介/兜底。

诊断 snapshot/read、失败点击、误入页面、重复输入、临时恢复动作不要固化。视觉教学成功后可以学习 semantic locator / stable selector，用于未来自动重放；这不会改变当前教学轮次必须服从用户指定操作方式的原则。
