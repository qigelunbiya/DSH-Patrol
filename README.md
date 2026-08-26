# DSH Patrol

> **Teach once. Patrol repeatedly.**  
> 面向 DeepSeek Harness 的对话式巡检 / Runbook Agent。

DSH Patrol 的目标不是再造一个浏览器自动化框架，而是把 Harness 已有插件能力拼起来，补上中间缺少的“巡检定义、教学录制、确认固化、确定性重放、结果断言、报告留档”这一层。

当前项目处于 **v0.1 Alpha**：先把一个最小但完整的核心闭环跑通，再逐步接入定时巡检、SSH、告警、Secret Store、自动修复等能力。

## 核心闭环

```text
用户描述巡检
        ↓
Agent 补齐信息
        ↓
生成 inspection.json
        ↓
Agent 使用浏览器执行一次
        ↓
成功的浏览器 Tool Call 自动记录为 Runbook Step
        ↓
用户确认结果正确
        ↓
固化 Runbook（draft → ready）
        ↓
再次执行 Runbook（不让 LLM 重新规划每一步）
        ↓
自动生成 report.json + report.md
```

核心原则：**Agent 负责把巡检教会系统，Runner 负责以后机械执行。** 只有流程失效、页面改版或需要修复时，才应该重新让 Agent 参与规划。

## v0.1 已完成

- ✅ DeepSeek Harness / Cordis 插件基础结构与 `cordis.patch.yml`。
- ✅ Patrol 专用系统提示词：要求 Agent 先补齐巡检信息，再进入教学模式。
- ✅ `inspection.json` v0.1 数据模型。
- ✅ 默认本地存储：`~/.dsh/patrol/inspections/<id>/inspection.json`。
- ✅ `patrol_create_draft`：生成巡检草稿。
- ✅ `patrol_execute_and_record`：通过真正的 `ctx.tools.execute()` 调用浏览器工具，成功后才写入 Runbook。
- ✅ `patrol_add_checkpoint`：登录、OTP、人工审批等敏感步骤采用 Human Checkpoint，不把秘密写入 JSON。
- ✅ `patrol_confirm`：用户明确确认后将 Runbook 从 `draft` 固化为 `ready`。
- ✅ `patrol_run`：按步骤确定性重放，不要求 LLM 重新发现页面操作。
- ✅ `contains` / `not-contains` 文本断言。
- ✅ 失败立即停止，并保留已完成步骤结果。
- ✅ 自动生成 `report.json` 与 `report.md`。
- ✅ 基础敏感字段持久化拦截、报告文本脱敏、`patrol_*` 递归保护。
- ✅ 默认 Runner 只允许 `browser_*`，避免第一版无边界执行任意 Harness 工具。
- ✅ 示例巡检与基础单元测试脚手架。

## 当前尚未完成 / 需要验证

- 🚧 **与 DeepSeek Harness 最新发行版的端到端安装验证**：代码按 Harness 当前 Cordis/ToolRuntime API 搭建，但仓库刚初始化，还需要在真实 DSH 环境执行 `pnpm install / build / plugin add` 全链路测试。
- 🚧 **浏览器 Provider 实机验证**：v0.1 默认期待已有插件提供 `browser_*` 工具；优先计划与 `Lum1104/dsh-browser` 联调。
- 🚧 **录制步骤编辑器**：当前错误录制建议重新创建 draft；还没有删除/重排/修改步骤工具。
- 🚧 **截图产物**：`artifacts` 可以声明 screenshot，但 Runner 暂时只保证 JSON/Markdown 报告。
- 🚧 **SecretResolver**：目前只保护“不落明文”，尚不能在运行时把 `${secret:...}` 自动解析为真实凭证。
- 🚧 **完整 Resume 状态机**：checkpoint 后可通过 `startAtStepId` 继续，但尚未持久化“本次运行的暂停上下文”。
- 🚧 **页面元素语义定位**：如果浏览器 Provider 依赖 snapshot index，页面改版后可能发生 index 漂移。

## 未来计划

### v0.2 — Browser Runbook 更稳定

- 录制步骤的删除、修改、重排。
- BrowserProvider 抽象层。
- semantic locator / text locator / selector fallback，降低 index 漂移影响。
- 截图、HTML、下载文件等 Artifact Provider。
- Runbook dry-run 与 diff 预览。

### v0.3 — Scheduling & History

- 参考 `dsh-automation` 接入 Cron/定时巡检。
- 运行历史索引、最近 N 次结果对比。
- 巡检超时、重试、失败策略。
- 成功/异常摘要。

### v0.4 — Secrets & Human Approval

- Secret Store / OS Keychain / Harness Credential 能力适配。
- `secret://` 引用解析，inspection.json 永不保存真实密码。
- OTP、重启、写操作、数据库变更等统一 Human Approval Step。

### v0.5 — Multi-provider Patrol

- 参考 `dsh-ssh` 增加服务器巡检。
- HTTP/API 巡检。
- 进程、文件、服务状态巡检。
- 参考 `dsh-sentinel` 增加条件触发和异常唤醒。

### v0.6 — Repair Mode

```text
Runner Step Failed
       ↓
Agent 接管失败现场
       ↓
重新识别页面 / 工具状态
       ↓
生成 Runbook Patch
       ↓
用户确认 Diff
       ↓
更新 inspection.json
```

目标是做到 **Self-healing inspection runbook**，但任何永久修改都必须可审查、可回滚。

## v0.1 工具

| Tool | 用途 |
| --- | --- |
| `patrol_create_draft` | 创建 `inspection.json` 草稿。 |
| `patrol_execute_and_record` | 教学模式：执行一个 `browser_*` 工具，成功后记录。 |
| `patrol_add_checkpoint` | 记录 OTP / 登录 / 审批等人工步骤。 |
| `patrol_confirm` | 用户确认后固化 Runbook。 |
| `patrol_run` | 机械重放 ready Runbook 并输出报告。 |
| `patrol_show` | 查看一个巡检定义。 |
| `patrol_list` | 列出所有巡检。 |

## inspection.json 示例

```json
{
  "schemaVersion": "0.1",
  "id": "prod-console-daily",
  "name": "生产管理台每日巡检",
  "status": "ready",
  "target": {
    "type": "browser",
    "url": "https://example.internal"
  },
  "expectedResult": "核心服务均显示正常，页面无红色告警。",
  "artifacts": ["markdown-report"],
  "auth": {
    "mode": "existing-session"
  },
  "schedule": null,
  "steps": [
    {
      "id": "step-001",
      "kind": "tool",
      "name": "读取服务状态",
      "tool": "browser_get_text",
      "arguments": {
        "selector": "#service-status"
      },
      "expectation": {
        "mode": "contains",
        "value": "正常",
        "caseSensitive": false
      },
      "recordedAt": "2026-08-26T00:00:00.000Z"
    }
  ],
  "metadata": {
    "createdAt": "2026-08-26T00:00:00.000Z",
    "updatedAt": "2026-08-26T00:00:01.000Z",
    "validatedAt": "2026-08-26T00:00:01.000Z"
  }
}
```

完整说明见 [`docs/inspection-schema.md`](docs/inspection-schema.md)。

## 安全设计

DSH Patrol 的 Runbook 很可能面向公司内网系统，所以安全不是后补功能。

- **禁止保存明文密码 / Token / Cookie / API Key。** 常见敏感字段会在持久化前被拒绝。
- **v0.1 优先使用已登录浏览器 Session。** 必须输入 OTP、密码或人工审批时，使用 checkpoint。
- **Runner 默认只允许 `browser_*`。** 以后接入 SSH/数据库等能力时，需要显式扩展 allowlist。
- **Runner 仍经过 Harness ToolRuntime。** 它调用 `ctx.tools.execute()`，不会绕过 Harness 的 guard、approval、timeout、post-execute 等策略链。
- **网页内容是不可信数据。** Patrol 不应该把页面文本当成系统指令。
- **报告只做基础脱敏。** 当前不是 DLP 产品，生产环境仍应限制报告目录权限和保留周期。

## 为什么复用现有项目

本项目的开发策略就是：**能复用的坚决不重写，只补兼容层和缺失的巡检语义。**

当前重点参考：

- [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)：Cordis 插件模型、SystemPrompt、ToolRuntime、执行流水线。
- [`Lum1104/dsh-browser`](https://github.com/Lum1104/dsh-browser)：控制用户当前浏览器/登录态的 `browser_*` 工具，是 v0.1 首选 Browser Provider 参考。
- [`MichengAI/dsh-automation`](https://github.com/MichengAI/dsh-automation)：未来定时任务、运行历史方向参考。
- [`fuhefei/dsh-sentinel`](https://github.com/fuhefei/dsh-sentinel)：未来条件监控、异常唤醒方向参考。

后续如果发现合适的 SSH、通知、Secret、报表插件，也优先通过 Adapter 拼装，而不是复制代码进本仓库。

## 开发

```bash
git clone https://github.com/qigelunbiya/DSH-Patrol.git
cd DSH-Patrol
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

安装到 DSH 的最终命令还需要在真实环境完成端到端验证。按照 Harness 当前插件 Bundle 机制，发布/本地链接后预计使用：

```bash
dsh plugin --profile web add dsh-patrol
```

如果 Browser Provider 没有注册 `browser_*` 工具，Patrol 的教学执行会明确失败，不会伪装成已经完成巡检。

## 数据目录

默认：

```text
~/.dsh/patrol/
├── inspections/
│   └── <inspection-id>/inspection.json
└── runs/
    └── <inspection-id>/<run-id>/
        ├── report.json
        └── report.md
```

## 项目结构

```text
DSH-Patrol/
├── src/
│   ├── index.ts          # Cordis 插件入口
│   ├── prompt.ts         # Patrol Agent 工作流提示词
│   ├── tools.ts          # patrol_* 工具
│   ├── runner.ts         # 确定性 Runbook Runner
│   ├── store.ts          # inspection/run 持久化
│   ├── report.ts         # 报告生成
│   ├── security.ts       # Secret 防落盘与基础脱敏
│   ├── validation.ts
│   └── types.ts
├── docs/
├── examples/
├── tests/
└── cordis.patch.yml
```

更详细的设计见 [`docs/architecture.md`](docs/architecture.md)。

## License

MIT
