# Browser Provider

DSH Patrol v0.2 自带 Browser Bridge，并把运行时明确分成两个插件：

- `dsh-patrol/browser-bridge-host`：Host plane。注册 WebSocket/HTTP route、提供进程共享的 `patrolBrowserBridge` service，并管理 Patrol 专用浏览器。
- `dsh-patrol/browser-tools`：Agent plane。只在「巡检模式」的 scoped ToolRuntime layer 中注册 `browser_*` 工具。

这样进程级 WebServer route 不会随着 Agent Preset mount/unmount 重复注册；标准模式也看不到 Patrol 的 browser tool schemas。

## 零配置 Managed Browser

默认情况下，用户不需要打开 `chrome://extensions` / `edge://extensions`，不需要开启开发者模式，也不需要手工“加载已解压的扩展程序”。

选择「巡检模式」时，Host 会自动：

1. 探测本机 Google Chrome、Microsoft Edge 或 Chromium（也可通过 `DSH_PATROL_BROWSER` 指定可执行文件）。
2. 使用 `$DSH_HOME/patrol/browser-profile` 启动一个 Patrol 专用、持久化的浏览器 Profile，不修改用户日常 Chrome/Edge Profile。
3. 首选 Puppeteer/CDP pipe 的运行时 Extension API（`Browser.installExtension()`）加载包内 `browser-extension`。
4. 如果当前 Chromium 构建明确报告运行时 Extension API 不可用，Managed Browser 会自动关闭这次启动并进行一次兼容启动重试；该兼容路径由 Patrol 自己完成，不把扩展安装步骤转嫁给用户。现代支持运行时 API 的 Chrome/Edge 不走此 fallback。
5. 自动写入正确的本地 Bridge URL，并让扩展连接 Host Bridge。
6. 后续巡检复用同一个 Patrol Profile，所以网页登录状态可以长期保留。
7. 用户关闭 Patrol 浏览器窗口后，下一次 Patrol browser request 会自动重新拉起它。

Chrome 对扩展启动参数的支持会随版本变化，因此 Patrol **不把命令行加载开关当作主路径**。主路径是运行时 Extension API；兼容路径只在浏览器明确拒绝该 API 时自动尝试，并且任何失败都会 fail closed、关闭本次启动的浏览器并报告自动 provisioning 错误，而不是要求用户手工安装扩展。

本地开发安装可以用 `scripts/uninstall-local.ps1` 一次清除当前 profile 的 Patrol Host 配置；只有确认没有其他 Harness profile 仍使用 Patrol 时，才会清除共享 Patrol Preset、Managed Browser Profile 和扩展注册。默认保留 inspection/run/report 数据；传 `-PurgePatrolData` 且不存在其他 Patrol profile 时才会一并删除巡检数据。

Bundle 安装还会写入一个 self-contained cleanup coordinator。执行 `dsh plugin remove` 后，下一次 Harness 启动时它会删除失效的 managed cleanup row，并在最后一个 Patrol profile 已移除时清理共享浏览器集成；它不依赖已被删除的 `dsh-patrol` 包。

## Patrol browser tools

```text
browser_status
browser_list_tabs
browser_activate_tab
browser_navigate
browser_snapshot
browser_read_page
browser_click
browser_type
browser_type_credential
browser_press
browser_scroll
browser_wait
browser_screenshot
```

Patrol Runtime 不注册 `browser_eval`，因此模型目录和 Runner allowlist 中都不存在这个能力。

## Browser hardening

仓库自带的 `browser-extension` 与 Provider 协议兼容，并额外限制：

- 不实现 eval command。
- 密码/secret/token/OTP/captcha 类 input 不返回 value。
- type command 的返回值永远不包含输入文本。
- `browser_type_credential` 的 ToolRuntime 参数只有 credential reference；明文值在 Provider execute 内部解析后直接发往扩展，不经过第二次 ToolRuntime dispatch。
- WebSocket 只接受 localhost / 127.0.0.1。
- Server upgrade 只接受 `chrome-extension://...` Origin。
- 扩展 manifest 固定 public key，使 Managed Browser 在不同安装路径/版本下维持稳定 extension ID。
- Managed Browser 把自己实际 provision 的精确 extension Origin 交给 Host；Host 在该 Origin 尚未确定时拒绝任何扩展连接，确定后只接受这个精确 Origin，并同步写入 `$DSH_HOME/patrol/trusted-extension-origin.txt`。
- DOM content-script 的 `{ok:false,error}` 会在扩展后台与 Provider 两层转换为真正失败。
- Manifest V3 CSP 禁止 unsafe-eval。
- content script 仅 top frame。

## Session reuse

Patrol 使用自己的持久化浏览器 Profile。第一次在该窗口完成某个站点登录后，后续 Harness 重启和巡检 Runbook 都可以复用该 Profile 中的 cookie/session，而无需把账号密码写入 Runbook。

这种设计有意不接管用户日常 Chrome 的默认 Profile：现代 Chrome 对默认 Profile 的自动化/远程调试限制更严格，而独立 Profile 也避免 Patrol 自动化影响用户正常浏览器会话。

Runbook 层不会持久化 `tabId`，也不会录制 `list-tabs` / `activate-tab` / back / forward；这些能力仅属于 Provider 诊断/交互层。
