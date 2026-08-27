# DSH Patrol v0.2 Architecture

## 1. Host plane vs Agent plane

DSH Patrol 明确拆成两层，避免把进程级 WebServer 能力塞进 Agent Preset：

- **Host plane**：`dsh-patrol/browser-bridge-host`。只创建一个 Browser Bridge transport，注册 `/patrol-browser-bridge` WebSocket/HTTP route，并提供进程共享的 `patrolBrowserBridge` service。
- **Agent plane**：`patrol` preset。`dsh-patrol/browser-tools` 消费 Host 的 `patrolBrowserBridge` service，只把 `browser_*` schemas 注册到该 preset 的 scoped ToolRuntime layer；`dsh-patrol` 负责教学、录制、Runner 和报告。

这遵循 Harness Agent Preset 的 composition contract：跨 session / process-global 的 service 和 route 属于 Host；某个 Agent 暴露给模型的 tool/prompt 属于 preset。

```text
Host composition
├── dsh-patrol/browser-bridge-host
│   ├── /patrol-browser-bridge (WebSocket)
│   ├── /patrol-browser-bridge/info (HTTP)
│   └── patrolBrowserBridge service
└── dsh-patrol/preset-installer        # package/bundle install path

Agent preset: patrol
├── persona
├── dsh-patrol/browser-tools           # scoped browser_* schemas only
└── dsh-patrol                         # patrol_* orchestration + runner
```

本地源码安装时，`scripts/install-local.ps1` 会把 Host bridge 的绝对 `file:///.../browser-bridge-runtime/index.js` 作为一个带 BEGIN/END marker 的 managed block 写进 `profiles/<profile>/cordis.patch.yml`；Agent preset 则引用 `tools-plugin.js` 和 `lib/index.js`。因此正常启动仍然只需要 `pnpm dsh web`。

## 2. Browser dispatch boundary

Patrol 自带的 Browser Bridge Runtime 提供固定 browser_* 工具，但 Patrol 不把“任意字符串工具名”当作运行时协议。

`patrol_browser_step` 接受 canonical action enum，并映射到固定工具表。`PatrolRunner.isToolAllowed()` 再做精确 allowlist 检查。

此外，Patrol 注册 Tool Guard。一个 browser_* 调用只有在它的 `parent` execution token 当前被 `PatrolRunner.dispatch()` 授权时才通过。这样不仅阻止模型直接调用，也阻止其他 composite transport 借“nested”身份绕过 Patrol。

Browser Bridge 的 WebSocket 只接受 Chromium extension Origin，并在 `$DSH_HOME/patrol/trusted-extension-origin.txt` 做首次配对；不同扩展 Origin 后续被拒绝。扩展后台与 Provider 都会把 DOM 返回的 `ok:false` 升格为失败，防止页面桥错误被 Runner 误记为成功。

## 3. Credentials

Runbook 使用 `${credential:NAME}`，并且只允许它出现在 `browser_type_credential.arguments.credentialRef`。Runner 只把 placeholder 转为引用名，**不会解析明文**。

`browser_type_credential` Provider 的 execute body 才调用 Harness `ctx.credentials.resolve(credentialRef(NAME))`，然后直接通过 WebSocket 给浏览器扩展发送 type command。这样明文不会成为 Patrol 参数，也不会成为嵌套 ToolRuntime 参数；definition、resume state 和 report 始终只保存引用或脱敏内容。

## 4. Conditional login

每个 ToolStep / CheckpointStep 可以带 `when`：

```json
{
  "sourceStepId": "step-002",
  "mode": "contains",
  "value": "登录",
  "caseSensitive": false
}
```

Runner 只基于已完成 prior step 的 output 做判断。条件不满足时记录 `skipped`，不会当作失败。

## 5. Checkpoint resume

checkpoint 不是“结束这次 run 再新建一次”。Runner 会把 `runId + startedAt + definitionUpdatedAt + prior results + nextStepIndex` 写进 `resumes/<inspection>.json`。

`patrol_resume` 先验证暂停时的 `definitionUpdatedAt` 仍等于当前 Runbook；不一致时 fail closed，避免在已修改步骤上继续旧 run。验证通过后 waiting checkpoint 转为 passed（表示用户已完成该人工操作），继续同一个 run，并保留 checkpoint 之前的 condition source output。用户可显式 `patrol_abort_run` 放弃 pending resume。

## 6. Artifacts

- `browser_screenshot` 的 Provider path 被复制到 Patrol run 的 `artifacts/`。
- `browser_read_page` 可配置 `artifact: page-text`，把脱敏后的页面文本写入 `artifacts/`。
- requested screenshot/page-text 如果没有实际生成，最终 artifact check 会把 run 标记为 failed。
- `page-summary` 默认由 deterministic Runner 从最后一次成功的 read-page 输出生成安全摘录并直接写入 report；交互 Agent 可在用户明确要求时通过 `patrol_get_run_page_data` 读取标记为 UNTRUSTED 的页面数据，再用 `patrol_save_summary` 覆盖为更自然的脱敏总结。

## 7. Conservative locator healing

点击 step 可以保存 `{text, role, tag}` semantic locator。如果原 CSS selector 失败：

1. Runner 调 `browser_snapshot`。
2. 只接受同时满足已记录 semantic fields 的候选。
3. 必须恰好一个候选。
4. 用候选 selector 重试一次。
5. 报告记录 `healedSelector`，但不自动修改 Runbook。

显式修复用 `patrol_update_selector`，并让 Runbook 回到 DRAFT。

## 8. Page prompt-injection boundary

read/snapshot 的 model-visible output 用 BEGIN/END UNTRUSTED PAGE DATA 包裹；system prompt 明确规定 DOM/页面内容只能作为被巡检数据，不能作为 Agent 指令。Browser extension 与 Patrol Browser Bridge Runtime 都不提供 `eval` 命令，Patrol allowlist 也不包含 `browser_eval`。

## Replay stability

Patrol 不把 Chromium `tabId`、标签页列表/激活操作或 back/forward 历史导航固化进 Runbook。重复执行只使用显式 URL 与可重放 DOM 动作，避免依赖浏览器进程内的临时标识和历史状态。
