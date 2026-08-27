# inspection.json schema notes (v0.2)

v0.2 新建 definition 使用 `schemaVersion: "0.2"`；读取仍接受已有 v0.1 基础 definition，下一次编辑/确认会升级为 v0.2。

核心结构：

```json
{
  "schemaVersion": "0.2",
  "id": "portal-workorders",
  "status": "ready",
  "target": { "type": "browser", "url": "https://portal.example.test/" },
  "artifacts": ["markdown-report", "json-report", "screenshot", "page-summary"],
  "auth": { "mode": "secret-ref" },
  "steps": []
}
```

Tool step：

```json
{
  "id": "step-004",
  "kind": "tool",
  "name": "输入密码",
  "tool": "browser_type_credential",
  "arguments": {
    "selector": "#password",
    "credentialRef": "${credential:PATROL_PORTAL_PASSWORD}",
    "clear": true
  },
  "sensitive": true,
  "when": {
    "sourceStepId": "step-002",
    "mode": "contains",
    "value": "登录",
    "caseSensitive": false
  },
  "recordedAt": "..."
}
```

点击 step 可额外保存：

```json
"locator": {
  "text": "全部工单",
  "role": "button",
  "tag": "button"
}
```

read-page step 可设置：

```json
"artifact": "page-text"
```

screenshot step 会使用：

```json
"artifact": "screenshot"
```

Checkpoint step 同样可以带 `when`，用于只在某个状态下要求人工操作。

## 禁止持久化

- 明文 password/token/API key/cookie/session id/OTP/captcha。
- 带 `user:password@host` 的 URL。
- URL 中 `password=...`、`token=...` 等敏感 query 参数。

Credential placeholder 必须使用 Harness reference name grammar：`[A-Za-z_][A-Za-z0-9_]*`。


## 条件引用规则

`when.sourceStepId` 必须引用当前 step **之前已经存在** 的 step，禁止前向/自引用；否则 deterministic Runner 无法在执行时得到条件源。

`browser_type_credential` 是唯一允许持久化 `${credential:REF}` 的工具；其他 tool step 出现 credential placeholder 会被校验拒绝。
