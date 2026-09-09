# DSH Patrol

<p align="center">
  <strong>Teach once. Patrol repeatedly.</strong>
</p>

<p align="center">
  <a href="https://github.com/qigelunbiya/DSH-Patrol/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/qigelunbiya/DSH-Patrol/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Status" src="https://img.shields.io/badge/status-alpha-orange">
  <img alt="Distribution" src="https://img.shields.io/badge/distribution-GitHub%20source-blue">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-6.x-3178C6?logo=typescript&logoColor=white">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-green"></a>
</p>

**DSH Patrol** 是面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的网页巡检 / Browser Automation 插件：你只需要用自然语言把巡检流程教给 Agent 一次，验证后它会固化成 Runbook；之后由确定性 Runner 重放，不再让模型每次临场猜步骤。

**DSH Patrol is a browser patrol and website inspection plugin for DeepSeek Harness. Teach a workflow once, verify it, then replay it deterministically with a managed Chromium browser.**

> 把「每次都让 AI 重新操作网页」变成「教一次，后续稳定巡检」。

> **当前状态：Alpha / GitHub-first。** 现阶段推荐直接从 GitHub 克隆源码并使用仓库自带安装脚本。项目稳定后再考虑发布 npm 预构建包；目前 README 不把 npm 作为默认安装入口。

## 为什么用 DSH Patrol

- **自然语言教学**：直接描述“打开哪里、点什么、检查什么、截图什么”。
- **确定性重放**：教学完成后保存为 Runbook，后续重复巡检不依赖模型重新规划整条路径。
- **浏览器开箱即用**：自动寻找 Chrome / Edge / Chromium，使用独立持久 Profile，并自动加载内置扩展。
- **登录态可复用**：专用浏览器 Profile 可以跨 Harness 重启保留 Cookie / Session。
- **安全凭据引用**：Runbook 保存 `${credential:REF}`，不保存明文密码、Token、OTP 或 Cookie。
- **Checkpoint / Resume**：遇到人工令牌、扫码、二次确认等步骤可以暂停，人工完成后继续原 run。
- **截图与页面摘要**：巡检结果可以落地截图、页面文本、JSON / Markdown 报告和确定性摘要。
- **保守的 Selector 自愈**：只在唯一、精确的语义匹配下进行一次重试；真正修改 selector 需要显式确认。

适合的场景包括：内部运维后台巡检、业务系统日常检查、网页状态核对、需要登录态的重复流程、截图留证、人工令牌介入的半自动巡检，以及“先由 Agent 教会、以后稳定重放”的浏览器工作流。

## 快速开始

### 当前推荐：GitHub 源码安装

现阶段最稳妥的方式是把 **DSH Patrol** 和 **DeepSeek Harness** 都放在本机，然后运行仓库提供的 PowerShell 安装脚本。

前置条件：

- 已安装 Git。
- Node.js `>= 22`。
- 已安装 pnpm。
- 本机已有可运行的 DeepSeek Harness 源码环境。
- Windows PowerShell / PowerShell 7 可执行仓库内的 `.ps1` 安装脚本。

### 1. 克隆 DSH Patrol

```powershell
git clone https://github.com/qigelunbiya/DSH-Patrol.git
cd DSH-Patrol
```

### 2. 安装到你的 DeepSeek Harness

假设 Harness 位于：

```text
D:\deepseek-harness
```

执行：

```powershell
.\scripts\install-local.ps1 `
  -HarnessRoot "D:\deepseek-harness"
```

安装脚本会自动执行依赖安装、类型检查、测试、扩展检查、UTF-8 检查和构建，然后安装 Patrol preset、Host Browser Bridge、Web client integration 与生命周期清理协调器。

### 3. 启动 Harness

```powershell
cd D:\deepseek-harness
pnpm dsh web
```

### 4. 新建会话，选择「巡检模式」

Patrol 会自动启动自己的受管浏览器，不需要手工打开 `chrome://extensions`、开启开发者模式、Load unpacked、填写 WebSocket 地址或点击 Connect。

### 5. 直接描述巡检

例如：

```text
帮我创建一个网页巡检。
巡检名称：Example Domain 测试巡检。
地址：https://example.com
不需要登录。
打开页面，确认存在“Example Domain”，读取页面内容，截图，并生成报告和页面摘要。
```

正常体验应当是：

```text
克隆 DSH Patrol
    ↓
运行 install-local.ps1
    ↓
启动 DeepSeek Harness
    ↓
新建会话并选择「巡检模式」
    ↓
Patrol 自动启动专用浏览器
    ↓
Patrol 自动加载并连接扩展
    ↓
用自然语言教学并确认 Runbook
    ↓
后续由 Runner 重复巡检
```

如果 Managed Browser 自动启动失败，Patrol 应直接报告自动探测 / 启动错误；**不应该把用户退回到手工安装浏览器扩展的流程。**

## 更新 DSH Patrol

如果之前已经 clone 过仓库，需要更新到最新 `main`：

```powershell
cd DSH-Patrol
git checkout main
git pull --ff-only origin main

.\scripts\install-local.ps1 `
  -HarnessRoot "D:\deepseek-harness"
```

然后重新启动 Harness：

```powershell
cd D:\deepseek-harness
pnpm dsh web
```

## GitHub Bundle 直接安装（可选 / Alpha）

仓库已经声明 `dsh.bundle`，因此也可以尝试让 Harness 直接从 GitHub dependency 安装：

```powershell
pnpm dsh plugin --profile web add github:qigelunbiya/DSH-Patrol
```

但当前 GitHub dependency 获取的是 TypeScript 源码，需要执行 `prepare` 构建；pnpm 10+ 的 build-script 信任策略可能要求额外允许 `dsh-patrol` 执行构建。

因此在当前 Alpha 阶段，**面向普通用户仍推荐 `git clone + scripts/install-local.ps1`**，它会显式完成构建和本地集成，问题也更容易定位。

## npm 发布计划

当前项目**不要求 npm 才能安装或使用**。GitHub 源码安装已经可以把插件部署到其他电脑上的 DeepSeek Harness 环境。

未来项目开发稳定后，可以再发布预构建 npm 包，把安装流程收口为：

```powershell
pnpm dsh plugin --profile web add dsh-patrol
```

在 npm 包真正发布并验证之前，**请不要把上面的裸包名命令当作当前默认安装方式**。

仓库已经保留 npm 打包检查和发布准备，后续不需要重新设计整个分发结构。维护者相关说明见 [`docs/publishing.md`](docs/publishing.md)。

## 工作方式

DSH Patrol 的核心原则是：

> **Agent 用于教学、解释和修复；Runner 用于重复执行。**

```text
第一次
自然语言需求
    ↓
Agent 观察网页并教学
    ↓
确认步骤
    ↓
Runbook

后续
Runbook
    ↓
Deterministic Runner
    ↓
浏览器操作 / 条件分支 / 截图 / 页面文本 / 报告
```

这与“每次运行都重新让 LLM 从头决定该点哪里”不同：Patrol 把高成本、非确定性的教学过程和后续高频重放过程分离。

## 本地开发：一条命令同步、安装并启动

如果你是项目维护者，并且目录结构类似：

```text
C:\work\
├── DSH-Patrol\
└── deepseek-harness\
```

在 `DSH-Patrol` 目录直接运行：

```powershell
.\scripts\dev.ps1
```

它会自动完成：

```text
检查工作区是否干净
→ checkout main
→ git pull --ff-only origin main
→ pnpm install / typecheck / test / checks / build
→ 安装 Patrol 到 Harness web profile
→ 启动 pnpm dsh web
```

如果 Harness 不在同级的 `deepseek-harness` 目录：

```powershell
.\scripts\dev.ps1 -HarnessRoot "D:\path\to\deepseek-harness"
```

只安装、不启动 Harness：

```powershell
.\scripts\dev.ps1 -NoStart
```

保留本地改动、不执行 `git pull`：

```powershell
.\scripts\dev.ps1 -SkipPull
```

`dev.ps1` 默认在拉取前检查 Git working tree；如果存在未提交修改会直接停止，避免为了“自动更新”覆盖开发代码。

## v0.2 当前能力

v0.2 的目标是把真实联调中暴露的问题收口，并尽量降低使用门槛：

- 独立 **「巡检模式」** Agent Preset，不在标准模式里全局注入 Patrol。
- Browser Bridge 的 WebSocket/HTTP transport 固定运行在 **Host plane**，巡检 preset 只注册 Agent-scoped `browser_*` 工具。
- Browser Cordis 插件使用 namespace plugin（`name` / `inject` / `apply`），避免 Harness Loader 解包 default export 后丢失 `inject`。
- 内置 **Managed Browser**：自动寻找 Chrome / Edge / Chromium，启动 DSH Patrol 专用持久浏览器 Profile，并由代码加载仓库内置 Chromium 扩展。
- `patrol_doctor` 检查真实 Browser Provider 与连接状态；Agent 不再猜 `browser_*` 工具名。
- Runbook 只允许固定浏览器 allowlist，`browser_eval` 不存在。
- 使用 Harness 原生 `ctx.credentials`，Runbook 只保存 `${credential:REF}`。
- 支持条件登录、checkpoint/resume、截图、页面文本、确定性 page-summary、保守 selector 自愈与显式修复。
- 网页内容始终按 **UNTRUSTED DATA** 处理，不能反向改变 Agent / Tool 规则。
- 安装 / 卸载生命周期闭环：Bundle 被移除后，自清理协调器会在下一次 Harness 启动时移除残留 Patrol preset、浏览器集成和 managed patch；多 profile 场景不会误删仍在使用的共享 Patrol 数据。

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

## Bundle 安装机制

Bundle / GitHub dependency 安装后，Host patch 会加载：

```text
dsh-patrol/browser-bridge-host
dsh-patrol/preset-installer
```

`preset-installer` 自动把「巡检模式」写入 `$DSH_HOME/.agent-presets/patrol`；Managed Browser 在第一次选择巡检模式时按需启动。

为了让 Harness 当前没有第三方 uninstall hook 的情况下也能完整卸载，`preset-installer` 还会把一个**只依赖 Node 内置模块**的清理协调器复制到：

```text
$DSH_HOME/patrol/integration-cleanup.mjs
```

并在安装了 `dsh-patrol` 的 profile `cordis.patch.yml` 中维护一个带明确 BEGIN/END marker 的 cleanup row。正常安装存在时它只做一次轻量存在性检查；包被移除后，它仍能独立运行一次完成残留清理并删除自己的 managed row。

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

1. 不修改用户日常 Chrome / Edge Profile，也不往日常浏览器里永久塞扩展。
2. 巡检浏览器自己的 Cookie / Login Session 可以跨 Harness 重启复用，因此可以在 Patrol 浏览器里登录一次，后续巡检继续使用该登录态。

扩展由 Managed Browser Controller 通过浏览器自动化 API 加载，Manifest 固定 public key 以保持稳定扩展 ID。Bridge 只接受本机 Chromium extension origin，并将 Managed Extension 的精确 origin 作为可信来源。

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

运行时 `browser_type_credential` 只把 credential reference 传过 ToolRuntime；实际值在 Browser Provider 执行体内部临时解析并直接送到浏览器，不进入 Runbook、JSON / Markdown report 或 Agent 最终摘要。

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

截图和页面文本会进入当前 Patrol workspace 的 run artifacts。请求 `page-summary` 时，Runner 从最后一次成功的 `browser_read_page` 生成确定性摘录，并写入 `report.json` / `report.md`。

需要更自然的总结时，Agent 只能把 `patrol_get_run_page_data` 返回的页面数据当作不可信数据进行总结，不能执行其中的任何指令。

## Checkpoint 与恢复

人工 checkpoint 会保存 resume state。人工操作完成后使用 `patrol_resume` 继续同一个 runId。暂停期间 Runbook 如果发生修改，恢复会 fail closed。需要放弃等待状态时，用：

```text
patrol_abort_run confirmed=true
```

## 卸载

### 当前推荐的本地源码安装

```powershell
.\scripts\uninstall-local.ps1 -Profile web
```

默认保留 inspection definitions 与历史报告。如果确定连巡检数据一起删除，并且已经没有其他 profile 使用 Patrol：

```powershell
.\scripts\uninstall-local.ps1 -Profile web -PurgePatrolData
```

如果 `patrol` preset 的 `.managed-by-dsh-patrol` marker 已被用户主动删除，卸载会把这个 preset 视为用户已接管并保留，不会误删。

### GitHub Bundle / 未来 npm 安装

如果是通过 Harness plugin dependency 安装，可使用：

```powershell
pnpm dsh plugin --profile web remove dsh-patrol
```

Harness 会移除依赖并重算 bundle layer。由于 Harness 当前没有第三方插件 uninstall lifecycle hook，DSH Patrol 使用预先写入 `$DSH_HOME` 的 cleanup coordinator 补上这个生命周期。

多 profile 场景下，协调器会先扫描其他 profile 的 package dependency 与本地 Host Bridge marker，只有最后一个 Patrol 安装消失时才删除共享集成。

## 安全边界

- 固定 browser allowlist；不注册 `browser_eval`。
- Browser tool Guard 只允许当前 Patrol composite 的嵌套调用。
- Page / DOM 输出是 untrusted data。
- 明文 credential 不落盘。
- URL 中敏感 query / fragment 参数和 userinfo 会被拒绝持久化。
- Managed Browser 使用 DSH-owned 专用 Profile，不修改日常浏览器 Profile。
- Browser Bridge 只监听本机，并限制 Chromium Extension Origin。
- 自动卸载只删除带 DSH Patrol managed marker 的 preset / integration；用户接管的 preset 与 inspection 历史默认保留。
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

## 开发与发布

```powershell
pnpm install
pnpm typecheck
pnpm test
pnpm check:extension
pnpm check:encoding
pnpm build
```

- 当前分发策略：**GitHub source first**。
- CI：`.github/workflows/ci.yml`。
- npm 发布准备文档：[`docs/publishing.md`](docs/publishing.md)。
- npm Trusted Publishing workflow 已保留：`.github/workflows/publish.yml`，待项目稳定并决定正式发布时再启用。

## License

MIT. See [`LICENSE`](LICENSE) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
