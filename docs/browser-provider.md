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
3. 通过 Puppeteer/CDP pipe 启动浏览器，并调用 `Extensions.loadUnpacked` 对应的 `Browser.installExtension()`，把包内 `browser-extension` 自动加载到该 Profile。
4. 自动写入正确的本地 Bridge URL，并让扩展连接 Host Bridge。
5. 后续巡检复用同一个 Patrol Profile，所以网页登录状态可以长期保留。
6. 用户关闭 Patrol 浏览器窗口后，下一次 Patrol browser request 会自动重新拉起它。

官方 Chrome 从 137 开始不再支持 branded Chrome 的 `--load-extension`，因此 Patrol 不依赖这个已废弃开关；Managed Browser 使用当前受支持的 CDP pipe + extension install 路径。

本地开发安装可以用 `scripts/uninstall-local.ps1` 一次清除 Patrol Preset、Host patch、Managed Browser Profile 和扩展注册。默认保留 inspection/run/report 数据；传 `-PurgePatrolData` 才会一并删除巡检数据。

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
- Managed Browser 自动把精确 extension Origin 写到 `$DSH_HOME/patrol/trusted-extension-origin.txt`；不同 ID 会被拒绝。
- DOM content-script 的 `{ok:false,error}` 会在扩展后台与 Provider 两层转换为真正失败。
- Manifest V3 CSP 禁止 unsafe-eval。
- content script 仅 top frame。

## Session reuse

Patrol 使用自己的持久化浏览器 Profile。第一次在该窗口完成某个站点登录后，后续 Harness 重启和巡检 Runbook 都可以复用该 Profile 中的 cookie/session，而无需把账号密码写入 Runbook。

这种设计有意不接管用户日常 Chrome 的默认 Profile：Chrome 136+ 已限制默认 Profile 的远程调试，而独立 Profile 也避免 Patrol 自动化影响用户正常浏览器会话。

Runbook 层不会持久化 `tabId`，也不会录制 `list-tabs` / `activate-tab` / back / forward；这些能力仅属于 Provider 诊断/交互层。
