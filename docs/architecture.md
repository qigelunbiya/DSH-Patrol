# DSH Patrol 架构说明

## v0.1 目标

DSH Patrol 不重新发明浏览器自动化，而是把 DeepSeek Harness 已有工具组织成“教一次、重复巡检”的 Runbook。

```text
用户描述巡检
  ↓
Patrol Agent Prompt：补齐需求 / 安全约束
  ↓
patrol_create_draft → inspection.json
  ↓
patrol_execute_and_record
  ├─ 调用 ctx.tools.execute(browser_*)
  └─ 成功后记录同一工具调用
  ↓
用户确认
  ↓
patrol_confirm → status=ready
  ↓
patrol_run
  ├─ 不让 LLM 重新规划
  ├─ 顺序 replay 记录的工具调用
  ├─ 执行文本断言
  └─ report.json + report.md
```

## 为什么不是“直接把对话保存成脚本”

对话不可执行、不可验证，也很难做兼容层。v0.1 把 Runbook 的最小执行单元定义为 Harness Tool Call：

```json
{
  "tool": "browser_get_text",
  "arguments": {},
  "expectation": {
    "mode": "contains",
    "value": "运行正常",
    "caseSensitive": false
  }
}
```

这样 Patrol 只负责生命周期、录制、断言、重放和报告；浏览器、SSH、API 等执行能力由各自插件负责。

## 组件

### Agent Prompt

`src/prompt.ts` 规定 Patrol Agent 的工作流程。它要求先补齐需求，并明确禁止把密码、Cookie、Token、OTP 写进 Runbook。

### Patrol Tools

- `patrol_create_draft`：创建巡检定义。
- `patrol_execute_and_record`：教学模式中的“执行 + 成功后录制”事务边界。
- `patrol_add_checkpoint`：记录登录、OTP、审批等人工步骤。
- `patrol_confirm`：用户确认后冻结为 ready。
- `patrol_run`：确定性回放并生成报告。
- `patrol_show` / `patrol_list`：查看本地 Runbook。

### Store

默认目录：`~/.dsh/patrol/`

```text
~/.dsh/patrol/
├── inspections/
│   └── <inspection-id>/inspection.json
└── runs/
    └── <inspection-id>/<run-id>/
        ├── report.json
        └── report.md
```

写入采用临时文件 + rename，减少中途崩溃导致 JSON 半写入的问题。

### Runner

Runner 通过 `ctx.tools.execute()` 回放步骤，因而仍然经过 Harness 的工具校验、guard、approval、timeout、post-execute 等流水线，而不是绕过安全策略直接调用第三方代码。

## 浏览器 Provider

v0.1 不绑定具体浏览器实现，只约定默认允许 `browser_*` 工具前缀。因此可优先复用 `Lum1104/dsh-browser` 一类已经实现的浏览器桥接插件。只要其他 Provider 注册兼容工具名，Patrol 无需修改核心 Runner。

当前索引式浏览器工具存在一个天然问题：页面 DOM 改版后，录制的元素 index 可能漂移。v0.1 会明确失败并保留报告；未来 Repair Mode 会让 Agent 分析失败位置并更新 Runbook。

## 安全边界

1. `patrol_*` 永远不能被 Runner 自己重放，避免递归。
2. 默认只能重放 `browser_*`，未来接 SSH/API 时必须显式扩展 allowlist。
3. 常见敏感字段名如果包含明文，会被拒绝持久化。
4. 敏感交互应该转为 checkpoint，而不是记录真实密码/OTP。
5. 报告会对常见 `Bearer`、token/password/cookie 文本进行基础脱敏；这不是完整 DLP，后续还需要 Secret Store 集成。

## 下一阶段接口方向

- BrowserProvider/Locator abstraction：从 index 重放升级为 semantic locator + fallback。
- SecretResolver：只存 `secret://` 引用，运行时短暂解析。
- SchedulerAdapter：复用 dsh-automation 的 Cron/运行历史思想。
- SSH Provider：复用 dsh-ssh 执行服务器巡检。
- Sentinel Adapter：条件触发巡检或失败后告警。
- Repair Mode：失败时由 Agent 接管，并以 diff 形式提议更新 inspection.json。
