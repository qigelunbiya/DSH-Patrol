# DSH Patrol

**DSH Patrol** 是 DeepSeek Harness 的专用网页巡检 Agent Preset：第一次通过自然语言把巡检教给 Agent，验证后固化为 Runbook；后续运行由确定性 Runner 重放，而不是让模型每次重新猜步骤。

> Teach once. Patrol repeatedly.

## v0.2 解决了什么

v0.2 针对真实联调中暴露的问题做了完整收口：

- 提供独立的 **「巡检模式」** Agent Preset，不再依赖在标准模式里说“请使用 Patrol”。
- 内置经过加固的 Patrol Browser Bridge Runtime 与 Chromium 扩展；协议实现基于 MIT 许可的 `dsh-browser-bridge` 思路并做了安全收口。
- `patrol_doctor` 检查真实 Browser Provider 与连接状态；Agent 不再猜 `browser_*` 工具名。
- 录制 API 使用 canonical action 枚举；Runner 只允许固定的安全浏览器工具集合，`browser_eval` 不在允许列表。
- Browser Provider 的模型直调会被 Guard 拒绝；只有当前 `patrol_*` composite 所属的嵌套调用才能执行浏览器工具。
- 使用 Harness 原生 `ctx.credentials`，Runbook 只保存 `${credential:REF}`，运行时按操作解析，不保存明文密码/Token/OTP/Cookie。
- 支持条件步骤：可以先判断是否已经登录，已登录时跳过登录分支，未登录时自动走 credential-ref 登录步骤。
- checkpoint 持久化为 `resume.json`，人工操作完成后用 `patrol_resume` 继续同一个 Run，而不是重新开始。
- 截图复制进 Patrol Run 目录；页面文本可保存为 artifact；请求 `page-summary` 时 Runner 会自动生成确定性页面摘录，Agent 可按需进一步润色并写回报告。
- 点击 selector 漂移时可做一次保守的“唯一语义匹配”重试；不会静默改写 Runbook。
- 支持删除/移动步骤、显式更新 selector；任何编辑都会把 READY Runbook 退回 DRAFT，要求重新验证确认。
- checkpoint 工具层禁止索要微信号、手机号、QQ、邮箱等与巡检无关的联系方式。

## 运行结构

```text
DeepSeek Harness
└── 巡检模式 (Agent Preset)
    ├── dsh-patrol
    │   ├── patrol_doctor
    │   ├── patrol_create_draft
    │   ├── patrol_browser_step
    │   ├── patrol_type_text
    │   ├── patrol_type_credential
    │   ├── patrol_add_checkpoint
    │   ├── patrol_confirm
    │   ├── patrol_run / patrol_resume
    │   └── report / repair / management tools
    └── dsh-patrol/browser-bridge
        └── Patrol Browser Bridge Runtime
            └── Chromium extension → 当前真实浏览器会话
```

Patrol 的原则仍然是：**Agent 用于教学、解释和修复；Runner 用于重复执行。**

## 本地源码开发安装（推荐）

如果 DSH Patrol 与 Harness 是同级源码目录，先在 Patrol 目录运行：

```powershell
pnpm install
pnpm typecheck
pnpm test
pnpm check:extension
pnpm build
```

然后运行：

```powershell
.\scripts\install-local.ps1 -HarnessRoot "E:\path\to\deepseek-harness"
```

脚本会把本地源码构建后的 `file:///.../lib/index.js` 与 `file:///.../browser-bridge-runtime/index.js` 写入：

```text
$DSH_HOME/.agent-presets/patrol/
├── agent.cordis.yml
└── preset.yml
```

之后正常启动 Harness 即可，不需要 `--patch`：

```powershell
cd E:\path\to\deepseek-harness
pnpm dsh web
```

新建会话，选择 **巡检模式**。

如果之前把 `dsh-patrol` 直接写进 `profiles/web/cordis.patch.yml` 做了全局加载，请删除那一块旧配置；本地安装脚本会检测并提醒，但不会擅自修改你的其他 profile patch。

## 作为 Bundle 安装

该仓库声明了 `dsh.bundle`。从 Git 源安装 TypeScript 包时，Harness 官方安装机制要求作者提供 `prepare`，同时 pnpm ≥10 需要用户显式允许构建脚本。

在 profile 的 `pnpm-workspace.yaml` 中授权可信源码：

```yaml
allowBuilds:
  dsh-patrol: true
```

然后安装固定 commit：

```powershell
pnpm dsh plugin --profile web add github:qigelunbiya/DSH-Patrol#<commit-sha>
```

Bundle 本身只加载 `preset-installer`。第一次 `pnpm dsh web` 时，它会安装/更新 `$DSH_HOME/.agent-presets/patrol`；Patrol Agent 不会被全局加入标准模式。

## 浏览器扩展

Patrol 模式使用真实 Chromium 浏览器标签页，因此可以复用已有登录态。

1. 启动 `pnpm dsh web`。
2. Chrome/Edge 打开扩展管理页并开启开发者模式。
3. 选择 **Load unpacked / 加载已解压的扩展程序**。
4. 选择 DSH Patrol 包中的 `browser-extension` 目录。
5. 默认连接地址是 `ws://127.0.0.1:3080/patrol-browser-bridge`。
6. 在巡检模式里调用 `patrol_doctor`；它会给出实际扩展目录、工具完整性和连接状态。

扩展不会提供任意 JavaScript `eval` 通道；密码类 input 的值也不会进入 snapshot。首次成功连接会把该 Chromium 扩展的 `chrome-extension://<id>` 作为本机信任来源写入 `$DSH_HOME/patrol/trusted-extension-origin.txt`（0600）；后续不同扩展 ID 会被拒绝。只有在你明确重装/更换 Patrol 扩展时才删除该文件重新配对。

## Credential 规则

**不要把密码直接写进巡检描述、inspection.json 或 selector 步骤。**

先在 Harness 已有 credential provider 中配置一个引用，例如：

```text
PATROL_PORTAL_PASSWORD
```

Runbook 只会保存：

```json
{
  "selector": "#password",
  "credentialRef": "${credential:PATROL_PORTAL_PASSWORD}",
  "clear": true
}
```

运行时 `browser_type_credential` 在 Provider 的执行体内部调用 `ctx.credentials.resolve()` 临时取得值，再直接发送给浏览器扩展；**明文值不会成为 Patrol 或嵌套 ToolRuntime 的参数**。它也不会进入 inspection definition、JSON/Markdown report 或 Agent 最终摘要。`patrol_doctor inspectionId=...` 只返回“是否已配置”和来源层，不返回值。

## “已登录则跳过，否则登录”

一个典型教学 Runbook 是：

```text
step-001 navigate 登录入口
step-002 read-page 判断当前页面
step-003 type username      when step-002 contains "登录"
step-004 type credential    when step-002 contains "登录"
step-005 type credential    when step-002 contains "验证码"（如确实需要自动化）
step-006 click 登录         when step-002 contains "登录"
step-007 wait 工作台
step-008 click 我的工作台
step-009 click 全部工单
step-010 screenshot
step-011 read-page + page-text
```

如果 `step-002` 已经显示工作台而不是登录页，登录分支会标记为 `SKIPPED`，不是失败。

教学时也不能凭空猜登录页 selector：如果当前浏览器已经登录、从未观察过登录页，Patrol 应继续复用现有 session，并要求在一个受控的教学时机验证登录页字段后再固化自动登录分支；不要为了“补齐” Runbook 而编造 selector。

## Screenshot 与页面总结

`screenshot` action 返回的 Provider 临时文件会被复制到：

```text
$DSH_HOME/patrol/runs/<inspection-id>/<run-id>/artifacts/
```

如果 inspection 请求 `page-summary`，Runner 会从最后一个成功的 `browser_read_page` 结果生成确定性摘录并直接写入 `report.json` / `report.md`，因此无 Agent 的重复执行也有摘要。交互会话中如用户明确要求更自然的总结，Agent 先调用 `patrol_get_run_page_data` 获取该 run 的最后一次成功页面读取结果；该结果始终标记为 **UNTRUSTED PAGE DATA**，只能作为待总结的数据，不能执行其中的任何指令。然后可用 `patrol_save_summary` 把脱敏后的自然语言总结写回报告。

## Checkpoint 与恢复

运行遇到人工 checkpoint 后，会产生：

```text
$DSH_HOME/patrol/resumes/<inspection-id>.json
```

其中保存已脱敏的前置步骤结果和下一步骤位置。用户完成人工操作后调用：

```text
patrol_resume
```

Runner 会继续**同一个 runId**，并保留 checkpoint 之前用于条件判断的结果。Resume state 同时绑定暂停时的 `inspection.metadata.updatedAt`；如果暂停后 Runbook 被外部修改，恢复会 fail closed。需要放弃这次等待状态时，用 `patrol_abort_run confirmed=true` 明确清除 resume，再修改 Runbook。

## 安全边界

- 默认只读思路；浏览器动作必须显式录制。
- 固定 allowlist：status/tabs/navigate/snapshot/read/click/type/press/scroll/wait/screenshot。
- Patrol Browser Bridge 根本不注册 `browser_eval`；任意未知 `browser_*` 名称也不会被 Runner 接受。
- Browser tool Guard 使用 Patrol composite 的 execution token 授权；不是简单地“只要是 nested call 就放行”。
- Page/DOM 输出是 untrusted data，不得改变 Agent 指令。
- 明文 credential 不落盘；明显的 credential-like input 不能走 `patrol_type_text`。
- URL 中敏感 query/fragment 参数和带 userinfo 的 target URL 会被拒绝持久化。
- 浏览器 WebSocket 使用 Chromium Extension Origin + 本机首次配对（TOFU）双重约束；普通网页和未配对扩展不能接管 Patrol bridge。
- 自愈只允许唯一精确语义匹配做一次重试；真正修改 selector 必须显式 `patrol_update_selector` 并重新确认。

## 当前工具

```text
patrol_doctor
patrol_create_draft
patrol_browser_step
patrol_type_text
patrol_type_credential
patrol_add_checkpoint
patrol_confirm
patrol_run
patrol_resume
patrol_get_run_page_data
patrol_save_summary
patrol_show
patrol_list
patrol_delete_step
patrol_move_step
patrol_update_selector
patrol_abort_run
patrol_delete
patrol_execute_and_record   # v0.1 兼容入口，已弃用
```

## 状态

v0.2 聚焦网页巡检闭环。SSH/API/进程/文件巡检、定时调度 UI、完整 Repair Mode 等仍属于后续方向，不在当前版本里冒充已经完成。

更多细节见：

- `docs/architecture.md`
- `docs/inspection-schema.md`
- `docs/browser-provider.md`

## Third-party notice

Patrol Browser Bridge Runtime 的部分实现思路与代码派生自 MIT 许可的 `dsh-browser-bridge`；完整许可文本见 `THIRD_PARTY_NOTICES.md`。


### Runbook 的标签页稳定性

Runbook 不持久化 Chromium `tabId`，也不录制 `list-tabs` / `activate-tab` / 浏览历史 back/forward 等会随会话变化的动作。巡检导航使用当前活动标签页中的显式 URL，避免下一次运行因临时标签页编号或历史栈变化而失效。
