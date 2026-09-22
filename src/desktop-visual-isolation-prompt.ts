export const PATROL_DESKTOP_VISUAL_ISOLATION_PROMPT = `DSH Patrol Desktop Visual Isolation（仅适用于 Windows 桌面应用；不得改变 browser_* / patrol_* 浏览器视觉策略）：
- browser 的 Action Map、candidateId、A1/A2 编号、XY/1000 网格、browser visualFrameId 复用、focused browser crop 等机制全部只属于浏览器。绝对不要把这些规则迁移到 desktop_*。
- 桌面视觉点击严格使用 048b 已验证链路：先激活目标顶层窗口，调用 desktop_screenshot(scope=active-window, processName/titleContains=目标应用)，只依据该工具返回并附加给模型的完整窗口截图判断目标；xRatio/yRatio 始终相对于这张完整窗口图本身计算。为了提高小按钮精度，desktop_screenshot 的模型可见 PNG 现在叠加桌面专用 XY/1000 网格，但不会改变图片宽高或 frame 矩形。
- 对 desktop_click_visual_point / patrol_desktop_action(action=click-visual-point)，使用刚刚这张桌面截图对应的 desktop frameId（若工具返回），在截图网格上读取目标可点击区域几何中心的 X/Y，然后严格按 xRatio=X/1000、yRatio=Y/1000 传入。不要再凭“右下角大概 0.9/0.8”目测比例；也不要从浏览器截图、聊天预览宽度、操作系统全屏尺寸、浏览器 Action Map/candidateId 或历史桌面截图换算坐标。
- 每次桌面视觉点击后重新 desktop_screenshot + read_image 验证结果；窗口移动、缩放、切换、重建或截图更新后，不复用旧桌面 frame。不要因为浏览器 frame 可以复用而复用 desktop frame。
- 本段只隔离桌面视觉语义。浏览器视觉巡检继续完全遵循现有 browser Action Map / row-context / visual-click 规则，不做任何改变。`
