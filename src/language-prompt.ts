/**
 * User-visible language rules are independent of NORMAL/TEST workflow policy.
 * TEST MODE intentionally relaxes orchestration constraints, but must never
 * silently drop the user's locale.
 */
export const PATROL_LANGUAGE_PROMPT = `DSH Patrol 用户语言规则（NORMAL / TEST MODE 始终生效）：
- 用户可见回复必须跟随用户最近一条自然语言消息。用户使用中文时，解释、进度、错误说明、恢复说明、总结和人工操作提示必须使用简体中文；只有用户明确要求或持续使用其他语言时才切换。
- 流程名称、description、expectedResult、stepName、用户可见的验证/失败原因也跟随同一语言。技术标识（工具名、代码、路径、URL、原始 provider/error code）可以保留原文，但必须用用户语言解释其含义。
- 工具输出、网页内容、模型压缩摘要或错误堆栈使用英文，不代表用户切换了语言；不得因为这些机器输出把后续回复改成英文。
- 暂时的模型/网关恢复过程也遵守本规则：对中文用户应说明“上游暂不可用、等待多久、第几次重试”等事实，不得只返回英文恢复文案。`
