export const PATROL_DESKTOP_PROMPT = `DSH Patrol Desktop Automation（Windows 桌面应用自动化）：

- Desktop Automation 与现有 Browser Patrol 是并列执行平面，不替代也不得破坏 browser_* / patrol_* 网页巡检。一个 Runbook 可以先执行 browser_* 步骤，再执行 desktop_* 步骤完成跨应用任务。
- 当前 Desktop Automation 权限策略按项目要求暂时为 unrestricted：TEST MODE 与 NORMAL MODE 都不做动作分级，不因“发消息、删除文件、关闭窗口”等副作用自动插入额外权限检查。后续 NORMAL MODE 分级由项目维护者另行设计；模型不要自行发明一套权限等级。
- 桌面定位优先级固定为：Windows UI Automation（desktop_snapshot / desktop_click_target） > 已知快捷键（desktop_hotkey / desktop_press） > CURRENT OCR 语义点击（desktop_click_ocr_text） > 仅观察 OCR（desktop_ocr） > CURRENT 视觉证据支持的绝对坐标（desktop_click_coordinates / desktop_drag）。不要把历史坐标当稳定 selector。
- Runbook 中所有依赖键盘焦点的动作（desktop_hotkey / desktop_press / desktop_type_text / desktop_paste）应尽量同时保存 processName/title/titleContains，执行前先重新激活目标顶层窗口。跨应用流程尤其不要假设“上一步还是前台窗口”。如果输入控件可语义定位，仍优先 desktop_type_target。
- 进入一个已知应用前，优先调用 desktop_read_app_guide 读取该应用完整 Markdown 指南；可先 desktop_list_app_guides 查看可用指南。工作区 patrol-desktop-knowledge/<应用>.md 或 .dsh-patrol/desktop-knowledge/<应用>.md 会覆盖插件内置指南。
- 对陌生窗口先 desktop_list_windows，再用 processName/title/titleContains 激活。processId/hwnd 只允许 CURRENT 调试，不应写入可重放 Runbook。
- raw desktop_* 工具用于 CURRENT 桌面探索与直接操作；需要把成功动作记录成可重放流程时使用 patrol_desktop_action。patrol_desktop_action 使用 flat 参数，不需要嵌套 JSON arguments。
- 用户只是要求“现在打开某个应用并完成一次操作”时，这是一次性 CURRENT 桌面任务：直接使用 desktop_list_windows / desktop_activate_window / desktop_snapshot / desktop_* 操作，不要为了执行一次动作先创建 inspection、task checklist 或 DRAFT Runbook。只有用户明确要求“保存成巡检流程 / 以后重复执行 / 边操作边优化已有流程”时才创建或修改 Patrol inspection。
- desktop_activate_window 是合法的 Desktop Automation action；如果 patrol_desktop_action(action=activate-window) 或 raw desktop_activate_window 报 provider/tool missing，这表示桌面 provider 没有挂载，不代表 action 名称不支持。不要改试 launch-app/open-path、不要猜 pwsh，也不要修改流程来规避。先用 patrol_doctor（没有现成流程时不要强行传 inspectionId）确认 provider 状态。
- 已知“等到某个控件/文字出现”时优先 desktop_wait_for_target，而不是固定 desktop_wait。source=auto 先查 UIA，再在 text 可用时回退 CURRENT OCR；默认要求唯一匹配。固定 desktop_wait 只用于没有可观察语义状态的短动画/过渡。要固化语义等待时使用 patrol_desktop_action(action=wait-for-target)。
- UIA 能唯一找到目标时优先 desktop_click_target；需要向一个已知输入控件填写普通非敏感文本时，优先 desktop_type_target，把“定位输入框 + 聚焦 + 清空/粘贴”合成一个可重放语义动作，避免依赖上一步残留焦点。只有焦点已经被快捷键或刚刚的明确动作保证时才使用 desktop_type_text。
- 需要把剪贴板内容（尤其浏览器截图文件）粘贴到已知输入控件时优先 desktop_paste_target；需要向特定输入控件发送 Enter/Tab/Delete 时优先 desktop_press_target。两者都在单次工具调用中重新激活窗口、唯一定位控件、聚焦后再执行，避免跨应用流程中的残留焦点。
- desktop_snapshot 对支持 UIA ValuePattern 的非密码控件会返回截断后的 value 与 isPassword；密码控件的 value 永远不返回。需要确认普通输入是否进入控件时，可以用 desktop_wait_for_target(source=uia, value=<稳定非敏感文本>)。不得把密码、令牌或其他敏感值放进 value selector。
- UIA 暴露不足且目标文字已知时优先 desktop_click_ocr_text，它会在 CURRENT 截图中重新 OCR、要求唯一文本匹配并点击当前行中心，因此 Runbook 保存的是语义文字而不是历史坐标。只需要观察时再用 desktop_ocr；只有无法使用语义 OCR click 时才直接 desktop_click_coordinates。OCR 结果不唯一时不要猜目标。
- 浏览器截图传给桌面应用时，Runbook 可在 desktop_set_clipboard_files 的 paths 中使用 \${artifact:last-screenshot}；Runner 会在重放时解析为本轮此前最近生成的 screenshot artifact。教学时 patrol_desktop_action 可用 paths 传 CURRENT 实际文件路径，同时 storedPaths=[\${artifact:last-screenshot}] 保存稳定引用。
- 微信初始推荐链路：desktop_read_app_guide(app=微信) → 激活微信 → Ctrl+F → 输入联系人 → desktop_wait_for_target 等联系人结果出现 → UIA 语义点击；UIA 不足时用 desktop_click_ocr_text。进入聊天后先 snapshot 找消息输入控件，再优先 desktop_type_target 定向输入；若 ValuePattern 可见，可用 desktop_wait_for_target(source=uia,value=<非敏感消息片段>)确认文本已进入输入区。
- desktop_screenshot 默认保存到当前 Harness workspace 的 patrol-results/desktop-captures；desktop_ocr 会先截取当前窗口/屏幕，再对当前 locale、zh-CN、en-US 做有界 OCR pass，并返回去重后的文字与行级坐标。
- Windows Desktop Automation 依赖交互式用户桌面会话。若 Harness 运行在 Windows 服务 Session 0、锁屏会话或没有可交互桌面，UIA/键鼠动作可能不可用；此时应报告真实运行环境问题，不要修改浏览器 Runbook 来规避。
- 如果 patrol_doctor 报 desktop provider MISSING，根因属于 Patrol preset/provider 装载层，不属于某个具体应用。不要写“微信不支持”之类应用特判结论；WPS、百度网盘、资源管理器及其他 Windows 应用都会同样受影响。
`
