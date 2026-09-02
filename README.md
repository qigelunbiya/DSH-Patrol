# DSH Patrol

> 🚧 **开发中（Under Development）**

**DSH Patrol** 是 DeepSeek Harness 的专用网页巡检 Agent Preset：第一次通过自然语言把巡检教给 Agent，验证后固化为 Runbook；后续运行由确定性 Runner 重放，而不是让模型每次重新猜步骤。

> Teach once. Patrol repeatedly.

## v0.2 目标

v0.2 的核心目标是把真实联调里暴露的问题收口，并把使用门槛压到尽可能低：

- 独立 **「巡检模式」** Agent Preset，不在标准模式里全局注入 Patrol。
- Browser Bridge 的 WebSocket/HTTP transport 固定运行在 **Host plane**，巡检 preset 只注册 Agent-scoped `browser_*` 工具。
- Browser Cordis 插件使用 namespace plugin（`name` / `inject` / `apply`），避免 Harness Loader 解包 default export 后丢失 `inject`。
- 内置 **Managed Browser**：选择巡检模式时自动寻找 Chrome / Edge / Chromium，启动 DSH Patrol 专用持久浏览器 Profile，并由代码加载仓库内置 Chromium 扩展。
- 用户不需要打开 `chrome://extensions` / `edge://extensions`，不需要开启开发者模式，不需要 Load unpacked，也不需要手工填写 WebSocket 地址或点击 Connect。
- `patrol_doctor` 检查真实 Browser Provider 与连接状态；Agent 不再猜 `browser_*` 工具名。
- Runbook 只允许固定浏览器 allowlist，`browser_eval` 不存在。
- 使用 Harness 原生 `ctx.credentials`，Runbook 只保存 `${credential:REF}`，不保存明文密码、Token、OTP、Cookie。
- 支持条件登录、checkpoint/resume、截图、页面文本、确定性 page-summary、保守 selector 自愈与显式修复。
- 网页内容始终按 **UNTRUSTED DATA** 处理，不能反向改变 Agent/Tool 规则。
- 安装/卸载生命周期闭环：Bundle 被移除后，预先安装到 `$DSH_HOME` 的自清理协调器会在下一次 Harness 启动时移除残留 Patrol preset、浏览器集成和自身 managed patch；多 profile 场景不会误删仍在使用的共享 Patrol 数据。

## 运行结构

```text
DeepSeek Harness
├── Host plane
│   └── dsh-patrol/browser-bridge-host
│       ├── Patrol Browser Bridge Runtime
│       └── Managed Browser Controller
│           ├── 自动寻找 Chrome / Edge / Chromium
│           ├── $DSH_HOME/patrol/browser-profile
│           └── 自动加载 browser-extension
│
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
    └── dsh-patrol/browser-tools
        └── browser_* tool schemas
```

Patrol 的原则仍然是：**Agent 用于教学、解释和修复；Runner 用于重复执行。**

## 用户体验

安装并启动 Harness 后，正常流程应当只有：

```text
安装 DSH Patrol
    ↓
启动 pnpm dsh web
    ↓
新建会话并选择「巡检模式」
    ↓
Patrol 自动启动专用浏览器
    ↓
Patrol 自动加载并连接扩展
    ↓
直接描述巡检需求
```

例如：

```text
帮我创建一个网页巡检。
巡检名称：Example Domain 测试巡检。
地址：https://example.com
不需要登录。
打开页面，确认存在“Example Domain”，读取页面内容，截图，并生成报告和页面摘要。
```

如果 Managed Browser 自动启动失败，Patrol 应报告自动探测/启动错误；**不应该要求用户改成手工安装扩展**。

## 本地源码开发安装

源码开发场景可直接运行：

```powershell
cd E:\path\to\DSH-Patrol
.\scripts\install-local.ps1 -HarnessRoot "E:\path\to\deepseek-harness"
```

`install-local.ps1` 会自动执行依赖安装、类型检查、测试、扩展检查、UTF-8 检查和构建，然后安装 Patrol preset、Host Bridge 配置以及生命周期清理协调器。

启动 Harness：

```powershell
cd E:\path\to\deepseek-harness
pnpm dsh web
```

不需要额外 `--patch`，也不需要手工安装浏览器扩展。

## Bundle 安装

仓库声明了 `dsh.bundle`。安装后 Bundle Host patch 会加载：

```text
dsh-patrol/browser-bridge-host
dsh-patrol/preset-installer
```

`preset-installer` 自动把「巡检模式」写入 `$DSH_HOME/.agent-presets/patrol`；Managed Browser 在第一次选择巡检模式时按需启动。

为了让 Harness 当前没有第三方 uninstall hook 的情况下也能完整卸载，`preset-installer` 还会把一个**只依赖 Node 内置模块**的清理协调器复制到：

```text
$DSH_HOME/patrol/integration-cleanup.mjs
```

并在安装了 `dsh-patrol` 的 profile `cordis.patch.yml` 中维护一个带明确 BEGIN/END marker 的 cleanup row。这个文件不是 Patrol 主运行时；正常安装存在时它只做一次轻量存在性检查。包被移除后，它仍能独立运行一次完成残留清理并删除自己的 managed row。

当前从 Git 源安装仍使用 TypeScript `prepare` 构建，因此 pnpm 对 Git build script 的信任策略可能要求 profile 允许 `dsh-patrol` 执行构建。后续发布预构建包后，这一步可以进一步收口。

## Managed Browser

Patrol 默认使用独立的持久浏览器 Profile：

```text
$DSH_HOME/patrol/browser-profile
```

默认探测顺序：

```text
Google Chrome
→ Microsoft Edge
→ Chromium
→ PATH 中的兼容 Chromium
```

也可以通过环境变量显式指定浏览器：

```text
DSH_PATROL_BROWSER=<browser executable path>
```

专用 Profile 的目的有两个：

1. 不修改用户日常 Chrome/Edge Profile，也不偷偷往日常浏览器里永久塞扩展。
2. 巡检浏览器自己的 Cookie/Login Session 可以跨 Harness 重启复用，因此用户可以在 Patrol 浏览器里登录一次，后续巡检继续使用该登录态。

扩展由 Managed Browser Controller 通过浏览器自动化 API 加载，Manifest 固定 public key 以保持稳定扩展 ID。Bridge 只接受本机 Chromium extension origin，并将 Managed Extension 的精确 origin 作为可信来源。

## 卸载

### 本地源码安装

本地源码安装可使用：

```powershell
.\scripts\uninstall-local.ps1 -Profile web
```

它会立即移除当前 profile 的 Host Bridge managed patch 与 cleanup managed patch。如果没有其他 Harness profile 仍在使用 DSH Patrol，还会清理：

```text
DSH Patrol 管理的「巡检模式」preset
$DSH_HOME/patrol/browser-profile
managed-browser.json
trusted-extension-origin.txt
browser-bridge 临时文件
integration-cleanup.mjs
```

如果另一个 profile 仍安装了 `dsh-patrol`，或仍存在本地源码安装的 managed Host Bridge，卸载脚本只移除当前 profile 的配置，**不会删除共享的 Patrol preset、浏览器 Profile 或清理协调器**。

如果 `patrol` preset 的 `.managed-by-dsh-patrol` marker 已被用户主动删除，卸载会把这个 preset 视为用户已接管并保留，不会误删。

默认保留 inspection definitions 与历史报告；如果确定连巡检数据一起删除，并且已经没有其他 profile 使用 Patrol：

```powershell
.\scripts\uninstall-local.ps1 -Profile web -PurgePatrolData
```

### Bundle / `dsh plugin remove`

Bundle 可以直接使用 Harness 原生命令移除：

```powershell
pnpm dsh plugin --profile web remove dsh-patrol
```

Harness 会移除依赖并重算 bundle layer。由于 Harness 当前没有第三方插件 uninstall lifecycle hook，包本身不能在“文件已经被 pnpm 删除之后”再执行代码；DSH Patrol 用预先写入 `$DSH_HOME` 的 cleanup coordinator 补上这个生命周期：

```text
dsh plugin remove dsh-patrol
        ↓
包与 bundle layer 被移除
        ↓
下一次 pnpm dsh web 启动
        ↓
profile 中的 self-contained cleanup row 先运行
        ↓
确认该 profile 已不再引用 Patrol
        ↓
删除该 profile 自己的 cleanup row
        ↓
若没有其他 profile 仍使用 Patrol：
  删除 managed preset / browser profile / state / trust / 临时 bridge 文件
  保留 inspections / runs / resumes
  删除 integration-cleanup.mjs 自身
```

因此不需要额外的手工“卸载后清残留”步骤；下一次 Harness 启动时，清理会在正常 UI 使用之前完成。多 profile 场景下，协调器会先扫描其他 profile 的 package dependency 与本地 Host Bridge marker，只有最后一个 Patrol 安装消失时才删除共享集成。

## Credential 规则

不要把密码直接写进巡检描述、`inspection.json` 或普通输入步骤。

先在 Harness credential provider 中配置引用，例如：

```text
PATROL_PORTAL_PASSWORD
```

Runbook 只保存：

```json
{
  "selector": "#password",
  "credentialRef": "${credential:PATROL_PORTAL_PASSWORD}",
  "clear": true
}
```

运行时 `browser_type_credential` 只把 credential reference 传过 ToolRuntime；实际值在 Browser Provider 执行体内部临时解析并直接送到浏览器，不进入 Runbook、JSON/Markdown report 或 Agent 最终摘要。

## “已登录则跳过，否则登录”

典型教学 Runbook：

```text
step-001 navigate 目标入口
step-002 read-page 判断当前状态
step-003 type username      when step-002 contains "登录"
step-004 type credential    when step-002 contains "登录"
step-005 click 登录         when step-002 contains "登录"
step-006 wait 工作台
step-007 click 我的工作台
step-008 click 全部工单
step-009 screenshot
step-010 read-page + page-text
```

如果 `step-002` 已经显示工作台，登录分支会标记为 `SKIPPED`。教学时不能凭空猜登录页 selector；没有观察过登录 DOM 时，应继续复用现有 Session，并等待受控教学机会。

## Screenshot 与页面摘要

截图和页面文本会进入：

```text
$DSH_HOME/patrol/runs/<inspection-id>/<run-id>/artifacts/
```

请求 `page-summary` 时，Runner 从最后一次成功的 `browser_read_page` 生成确定性摘录，并写入 `report.json` / `report.md`。需要更自然的总结时，Agent 只能把 `patrol_get_run_page_data` 返回的页面数据当作不可信数据进行总结，不能执行其中的任何指令。

## Checkpoint 与恢复

人工 checkpoint 会保存：

```text
$DSH_HOME/patrol/resumes/<inspection-id>.json
```

人工操作完成后使用 `patrol_resume` 继续同一个 runId。暂停期间 Runbook 如果发生修改，恢复会 fail closed。需要放弃等待状态时，用 `patrol_abort_run confirmed=true`。

## 安全边界

- 固定 browser allowlist；不注册 `browser_eval`。
- Browser tool Guard 只允许当前 Patrol composite 的嵌套调用。
- Page/DOM 输出是 untrusted data。
- 明文 credential 不落盘。
- URL 中敏感 query/fragment 参数和 userinfo 会被拒绝持久化。
- Managed Browser 使用 DSH-owned 专用 Profile，不修改日常浏览器 Profile。
- Browser Bridge 只监听本机，并限制 Chromium Extension Origin。
- 自动卸载只删除带 DSH Patrol managed marker 的 preset/integration；用户接管的 preset 与 inspection 历史默认保留。
- 自愈只允许唯一精确语义匹配做一次重试；真正修改 selector 必须显式更新并重新确认。

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
patrol_execute_and_record   # v0.1 compatibility, deprecated
```
