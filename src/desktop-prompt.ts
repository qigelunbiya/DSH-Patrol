export const PATROL_DESKTOP_PROMPT = `DSH Patrol Desktop Automation（Windows 桌面应用自动化）：

- Desktop Automation 与现有 Browser Patrol 是并列执行平面，不替代也不得破坏 browser_* / patrol_* 网页巡检。一个 Runbook 可以先执行 browser_* 步骤，再执行 desktop_* 步骤完成跨应用任务。
- 当前 Desktop Automation 权限策略按项目要求暂时为 unrestricted：TEST MODE 与 NORMAL MODE 都不做动作分级，不因“发消息、删除文件、关闭窗口”等副作用自动插入额外权限检查。后续 NORMAL MODE 分级由项目维护者另行设计；模型不要自行发明一套权限等级。
- 桌面定位优先级固定为：Windows UI Automation（desktop_snapshot / desktop_click_target） > 已知快捷键（desktop_hotkey / desktop_press） > CURRENT OCR 语义点击（desktop_click_ocr_text） > 仅观察 OCR（desktop_ocr） > CURRENT 视觉证据支持的绝对坐标（desktop_click_coordinates / desktop_drag）。不要把历史坐标当稳定 selector。
- 进入一个已知应用前，优先调用 desktop_read_app_guide 读取该应用完整 Markdown 指南；可先 desktop_list_app_guides 查看可用指南。工作区 patrol-desktop-knowledge/<应用>.md 或 .dsh-patrol/desktop-knowledge/<应用>.md 会覆盖插件内置指南。
- 对陌生窗口先 desktop_list_windows，再用 processName/title/titleContains 激活。processId/hwnd 只允许 CURRENT 调试，不应写入可重放 Runbook。
- raw desktop_* 工具用于 CURRENT 桌面探索与直接操作；需要把成功动作记录成可重放流程时使用 patrol_desktop_action。patrol_desktop_action 使用 flat 参数，不需要嵌套 JSON arguments。
- UIA 能唯一找到目标时优先 desktop_click_target；UIA 暴露不足且目标文字已知时优先 desktop_click_ocr_text，它会在 CURRENT 截图中重新 OCR、要求唯一文本匹配并点击当前行中心，因此 Runbook 保存的是语义文字而不是历史坐标。只需要观察时再用 desktop_ocr；只有无法使用语义 OCR click 时才直接 desktop_click_coordinates。OCR 结果不唯一时不要猜目标。
- 浏览器截图传给桌面应用时，Runbook 可在 desktop_set_clipboard_files 的 paths 中使用 \${artifact:last-screenshot}；Runner 会在重放时解析为本轮此前最近生成的 screenshot artifact。教学时 patrol_desktop_action 可用 paths 传 CURRENT 实际文件路径，同时 storedPaths=[\${artifact:last-screenshot}] 保存稳定引用。
- 微信初始推荐链路：desktop_read_app_guide(app=微信) → 激活微信 → Ctrl+F → 输入联系人 → UIA snapshot/语义点击；UIA 不足时用 desktop_click_ocr_text 按联系人文字做 CURRENT OCR 语义点击；发送浏览器巡检截图时使用文件剪贴板 + paste，再按 CURRENT 微信状态继续。
- desktop_screenshot 默认保存到当前 Harness workspace 的 patrol-results/desktop-captures；desktop_ocr 会先截取当前窗口/屏幕，再对当前 locale、zh-CN、en-US 做有界 OCR pass，并返回去重后的文字与行级坐标。
- Windows Desktop Automation 依赖交互式用户桌面会话。若 Harness 运行在 Windows 服务 Session 0、锁屏会话或没有可交互桌面，UIA/键鼠动作可能不可用；此时应报告真实运行环境问题，不要修改浏览器 Runbook 来规避。
`
