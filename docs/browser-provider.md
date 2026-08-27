# Browser Provider

DSH Patrol v0.2 自带 Browser Bridge，但运行时明确分成两个插件：

- `dsh-patrol/browser-bridge-host`：Host-plane transport。注册 WebSocket/HTTP route，并提供进程共享的 `patrolBrowserBridge` service。
- `dsh-patrol/browser-tools`：Agent-plane tool registrar。只在「巡检模式」的 scoped ToolRuntime layer 中注册 `browser_*` 工具。

这样进程级 WebServer route 不会随着 Agent Preset mount/unmount，也不会因为切换模式而重复注册；标准模式同时看不到 Patrol 的 browser tool schemas。核心 WebSocket/协议实现基于 MIT 许可的 `dsh-browser-bridge` 派生并经过 Patrol 安全加固。

Patrol 使用的工具集合：

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

## Browser extension hardening

仓库自带的 `browser-extension` 与 Provider 协议兼容，但有额外限制：

- 不实现 eval command。
- 密码/secret/token/OTP/captcha 类 input 不返回 value。
- type command 的返回值永远不包含输入文本。
- `browser_type_credential` 的 ToolRuntime 参数只有 credential reference；明文值在 Provider execute 内部解析后直接发往扩展，不经过第二次 ToolRuntime dispatch。
- WebSocket 配置页只接受 localhost / 127.0.0.1。
- Server 的 WebSocket upgrade 只接受 `chrome-extension://...` Origin，普通网页不能冒充 Patrol 扩展接管 bridge。
- 首次成功连接采用 TOFU（trust on first use）记录精确扩展 Origin 到 `$DSH_HOME/patrol/trusted-extension-origin.txt`（0600）；后续不同扩展 ID 会被拒绝。重装/更换扩展时由用户明确删除该文件后重新配对。
- DOM content-script 的 `{ok:false,error}` 会在扩展后台与 Provider 两层都转换为真正失败，避免 snapshot/read/wait 把页面错误误判为成功。
- Manifest V3 CSP 禁止 unsafe-eval。
- content script 仅 top frame，减少不必要的跨 frame 权限面。

## Session reuse

扩展操作用户已经打开的真实 Chromium 标签页。因此若目标系统已经登录，Patrol 可以直接复用浏览器 session/cookie，而不需要重新保存登录信息。

Runbook 层不会持久化 `tabId`，也不会录制 `list-tabs` / `activate-tab` / back / forward；这些能力仅属于 Provider 诊断/交互层。
