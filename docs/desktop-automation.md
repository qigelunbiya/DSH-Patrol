# Desktop Automation

DSH Patrol 的 Desktop Automation 是独立于 Browser Bridge 的 Windows 桌面执行平面。浏览器巡检原有的 managed Chromium、browser_* provider、登录态、验证码、selector 恢复逻辑保持不变；桌面能力通过 `dsh-patrol/desktop-tools` 单独注册，然后由同一个 Patrol Runner 在需要时重放。

## 当前权限策略

当前开发阶段按项目约定：

- TEST MODE：Desktop Automation 不做权限分级。
- NORMAL MODE：暂时同样不做权限分级。
- 发送消息、关闭窗口、删除文件、粘贴文件等动作不会被 DSH Patrol 自己额外拦截。
- NORMAL MODE 的最终权限等级、确认机制和动作分类由项目维护者根据真实联调结果再设计。

这条策略只影响 Desktop Automation；原有浏览器凭据、验证码、Runbook 安全规则仍按各自既有逻辑工作。

## 执行策略

定位优先级固定为：

```text
Windows UI Automation
        ↓ 不可见 / 自绘 UI
稳定快捷键 / 键盘
        ↓ 仍不足
CURRENT OCR 语义点击（按文字重新定位并点击）
        ↓ 只观察 / 诊断
Windows OCR（返回行级 rect / center）
        ↓ 仍不足
CURRENT OCR/视觉证据支持的坐标点击 / 拖拽
```

不要把旧截图里的坐标当成稳定 Runbook selector。UIA 找不到、但目标文字稳定时优先 `desktop_click_ocr_text`：它会在每次执行时重新 OCR 并点击唯一文字的 CURRENT 中心，因此比持久化绝对坐标稳定。`desktop_ocr` 仍会返回每条 OCR 行的绝对屏幕 `rect` 与 `center` 供诊断。

## 原语层与 Runbook 层

原语层用于 CURRENT 桌面探索：

```text
desktop_list_windows
desktop_activate_window
desktop_snapshot
desktop_click_target
desktop_click_ocr_text
desktop_click_coordinates
desktop_drag
desktop_type_text
desktop_type_target
desktop_hotkey
desktop_press
desktop_wait
desktop_wait_for_target
desktop_screenshot
desktop_ocr
desktop_set_clipboard_text
desktop_set_clipboard_files
desktop_paste
desktop_close_window
desktop_delete_path
desktop_launch_app
desktop_open_path
desktop_list_app_guides
desktop_read_app_guide
```

需要把一个成功动作保存进可重放 Runbook 时，使用：

```text
patrol_desktop_action
```

raw `desktop_*` 成功只代表 CURRENT 操作成功，并不等于该动作已经进入 Runbook。

### 键盘焦点与跨应用切换

`desktop_hotkey`、`desktop_press`、`desktop_type_text`、`desktop_paste` 都允许附带稳定的顶层窗口 selector：

```text
processName
title
titleContains
```

当这些 selector 存在时，Desktop Runtime 会在发送键盘输入/粘贴前重新解析并激活目标窗口，并在结果中返回实际 window 记录。跨应用 Runbook 应优先这样保存，避免“浏览器 → 微信 → WPS”切换后把 Ctrl+V、Enter 或快捷键发送给错误窗口。

如果输入框本身可以被 UI Automation 唯一定位，继续优先 `desktop_type_target`；window-targeted `desktop_type_text` 只是比纯粹依赖当前前台焦点更安全的后备。

### 语义等待

当下一状态有明确控件或文字时，优先：

```text
desktop_wait_for_target
  source=auto
  text=<稳定文字>
  requireUnique=true
  timeoutMs=10000
```

`source=auto` 会先读取 CURRENT UI Automation tree；如果提供了 `text` 且 UIA 没命中，再回退 CURRENT OCR。它只在匹配满足条件时返回成功，因此比固定 `desktop_wait` 更适合可重放流程。

固定 `desktop_wait` 保留给没有可观察语义状态的短动画、系统对话框过渡或应用自身延迟。需要保存进 Runbook 时使用 `patrol_desktop_action(action=wait-for-target)`。

### 定向文本输入

当输入框能通过 UI Automation 稳定识别时，优先使用：

```text
desktop_type_target
  processName=WeChat
  controlType=Edit
  className=<CURRENT snapshot 中唯一稳定的 class>
  text=<普通非敏感文本>
  clear=true
```

它会完成“激活窗口 → 唯一定位控件 → 聚焦 → 可选清空 → 粘贴文本”，避免把输入正确性寄托在上一步是否仍保持键盘焦点。需要写入 Runbook 时使用 `patrol_desktop_action(action=type-target)`。

`desktop_snapshot` 对支持 UIA `ValuePattern` 的**非密码控件**会返回最多 2000 字符的 `value`，并返回 `isPassword`。密码控件不会读取或输出 `value`。因此普通文本可以通过 `desktop_wait_for_target(source=uia, value=<非敏感片段>, match=contains)` 做 CURRENT 验证；密码、Token、验证码等敏感值不得这样保存或验证。

## 两种流程类型

### 1. 纯桌面流程

例如只操作微信：

```text
patrol_create_inspection
  targetType=desktop
  desktopApp=微信
  desktopProcessName=WeChat
  desktopTitleContains=微信
```

纯桌面流程不需要也不应该编造 `targetUrl`。

### 2. 浏览器 + 桌面混合流程

例如：

```text
网页登录后台
→ 打开待办工单
→ 截图
→ 激活微信
→ 搜索联系人
→ 粘贴本轮网页截图
→ 发送
```

这种情况继续使用 browser target。Browser 与 Desktop 步骤保存在同一个 Runbook 中，由 Patrol Runner 按顺序执行。

浏览器截图可以通过：

```text
${artifact:last-screenshot}
```

传给后面的：

```text
desktop_set_clipboard_files
```

从而完成浏览器产物到微信、WPS、网盘等桌面应用的交接。

## 应用知识库

内置知识库：

```text
desktop-knowledge/
├── 微信.md
├── WPS.md
└── 百度网盘.md
```

工作区可覆盖：

```text
patrol-desktop-knowledge/微信.md
```

或：

```text
.dsh-patrol/desktop-knowledge/微信.md
```

同名工作区文件优先于插件内置指南。

知识库只保存稳定经验，例如快捷键、搜索入口和恢复顺序；真正操作前仍必须以 CURRENT `desktop_snapshot` / `desktop_ocr` 为准。

## 微信首轮联调建议

第一轮不要直接测试复杂群聊、文件上传和多窗口。先从下面的最短闭环开始：

```text
1. 确认微信已经登录并显示主窗口
2. desktop_list_windows 找到微信
3. desktop_activate_window 激活微信
4. desktop_snapshot 观察 UIA 是否能看到搜索框/联系人列表
5. desktop_hotkey 发送 Ctrl+F
6. desktop_type_text 输入一个明确且唯一的联系人名称
7. desktop_wait_for_target 等待联系人结果出现（source=auto，text=联系人名称）
8. desktop_snapshot 再次观察
9. UIA 能唯一定位联系人时 desktop_click_target
10. 如果 UIA 看不到结果，优先 desktop_click_ocr_text 按联系人名称做唯一语义匹配；失败后再 desktop_ocr 查看文字与坐标
11. desktop_wait_for_target 等待聊天标题/输入区进入可操作状态
12. desktop_snapshot 找到消息输入区的稳定 UIA selector
13. desktop_type_target 定向输入一条普通测试消息
14. 如果该控件提供 ValuePattern，用 desktop_wait_for_target(source=uia,value=<测试消息片段>)确认输入成功
15. desktop_press Enter
16. desktop_wait_for_target 或 desktop_snapshot / desktop_ocr 确认消息已出现在当前聊天
```

这条链路跑通后，再测试：

```text
网页巡检截图
→ ${artifact:last-screenshot}
→ desktop_set_clipboard_files
→ desktop_paste
→ 微信图片预览
→ Enter 发送
```

## 建议的自然语言测试

纯微信测试：

```text
进入测试模式，帮我创建一个纯桌面巡检。
目标应用是微信。
先找到并激活微信，然后搜索联系人“测试联系人”，进入聊天后发送“DSH Patrol Desktop Automation 测试”。
整个过程需要保存成可重复执行的流程。
```

浏览器 + 微信测试：

```text
进入测试模式。
先打开指定网页完成巡检并截图，然后打开微信，搜索联系人“测试联系人”，把刚才的网页截图发送给他。
把浏览器和微信操作保存成同一条巡检流程。
```

## 当前运行环境要求

Desktop Automation 需要真实的交互式 Windows 用户桌面会话。

以下情况可能无法正常操作：

- Harness 作为 Windows Service 运行在 Session 0。
- Windows 已锁屏。
- 当前用户没有可交互桌面。
- 目标应用运行在不同用户/session。
- 应用以更高完整性级别运行，而 Harness 没有相同权限。
- 某些自绘 UI 完全不暴露 UI Automation，并且 OCR/坐标也无法提供稳定证据。

遇到这些情况应报告真实环境问题，不要修改浏览器 Runbook 来绕过。

## 调试入口

先运行：

```text
patrol_doctor
```

重点确认：

```text
desktop provider
desktopAutomation=windows-uia+keyboard+ocr+coordinates
desktopPermissions=unrestricted
```

然后用：

```text
desktop_status
desktop_list_windows
desktop_list_app_guides
desktop_read_app_guide app=微信
```

确认桌面执行层和微信知识库均已加载。
