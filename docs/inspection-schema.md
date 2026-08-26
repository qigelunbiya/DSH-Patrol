# inspection.json v0.1

`inspection.json` 是 DSH Patrol 的稳定输入，而不是对话记录。

## 顶层字段

| 字段 | 说明 |
| --- | --- |
| `schemaVersion` | 当前固定为 `0.1`。 |
| `id` | 目录和运行历史使用的稳定 ID。 |
| `name` / `description` | 人类可读信息。 |
| `status` | `draft` 或 `ready`。 |
| `target` | v0.1 固定为 browser + URL。 |
| `expectedResult` | 整体巡检成功的自然语言定义。 |
| `artifacts` | 用户希望获得的产物；v0.1 实际保证 report.json/report.md，截图尚未实现。 |
| `auth` | 认证策略。禁止保存明文凭证。 |
| `schedule` | 预留字段；v0.1 尚未启用调度器。 |
| `steps` | 可重放工具步骤和人工 checkpoint。 |
| `metadata` | 创建、修改、确认时间。 |

## Tool Step

```json
{
  "id": "step-002",
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
```

`expectation` 是 v0.1 的最小机器断言，只支持 `contains` 和 `not-contains`。后续会扩展数值阈值、正则、结构化 JSONPath、截图视觉比较等。

## Checkpoint Step

```json
{
  "id": "step-003",
  "kind": "checkpoint",
  "name": "完成短信二次验证",
  "prompt": "请在当前浏览器完成短信验证码，然后继续。",
  "reason": "otp",
  "recordedAt": "2026-08-26T00:00:00.000Z"
}
```

Runner 到 checkpoint 会停止并生成 `waiting` 报告。完成人工动作后，可使用 `patrol_run(startAtStepId=下一步骤)` 继续。

## Secret 原则

不要这样写：

```json
{ "password": "123456" }
```

未来允许的形态会类似：

```json
{ "password": "${secret:prod-console.password}" }
```

但 v0.1 还没有 SecretResolver，所以推荐使用已登录浏览器 Session 或人工 checkpoint。
