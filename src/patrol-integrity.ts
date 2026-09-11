import type { Context } from '@deepseek-ai/cordis'
import { createFlowMutationConsentController } from './flow-mutation-consent.js'

/**
 * Integrity rules that remain active even when CAPTCHA/test diagnostics relax
 * ordinary recovery gates. Correctness is enforced without making ordinary
 * clicks harder: semantic clicks may self-verify a CURRENT state change when a
 * concrete post-click label is not known yet.
 */
export const PATROL_INTEGRITY_PROMPT = `DSH Patrol 可复用流程完整性规则（NORMAL/TEST MODE 均强制生效，本节不得被测试模式放宽）：
- patrol_create_draft 成功后，第一件事必须调用 patrol_set_task_checklist，把用户原始要求拆成按顺序的业务任务清单并持久化。清单必须覆盖用户明确要求的每一个导航、点击、输入、读取、截图和打开详情动作。清单未建立前运行时会拒绝教学浏览器动作；之后只按清单推进，不得因为某一步困难而自行改写业务目标。
- 如果 CURRENT 页面已经出现了清单中的下一个明确操作目标（例如用户明确要求“点击 Logo”，而页面当前只显示 Logo），立即执行该操作。不得把“点击后才会出现的内容”误当成“点击前还需要继续等待的加载内容”，也不得用无意义 wait/read/snapshot 循环拖延明确动作。
- 用户明确要求填写的字段必须拥有真实可重放的输入步骤。即使 CURRENT 页面已经自动填好用户名、工号或普通文本，也必须通过对应 patrol_* 输入工具规范化并记录；“这次页面碰巧预填”不能替代下一次重放所需动作。敏感值仍只保存安全引用，绝不保存明文。
- 业务点击优先使用 patrol_click_target。若点击后的具体业务文本已经从用户要求或 CURRENT 证据中明确知道，可提供 expectedText；若未知（例如 Logo 揭示表单、自定义菜单展开），不要猜 expectedText，直接省略，让 Patrol 通过点击前后 URL/可交互 DOM/页面状态变化自动验证。禁止为了满足参数而杜撰成功条件。
- 新建 DRAFT 的顶层 targetUrl 在教学开始后锁定。用户要求“点击某入口”时，不得用猜测 URL 的 patrol_navigate 代替该点击，也不得先调用 patrol_update_inspection 把猜测 URL 改成新 target 再绕过导航保护。只有用户明确改变了任务目标时才允许重建/清空流程后使用新 target。
- 已有非空流程与当前用户描述不完全一致时，默认策略必须是“保留旧流程并做最小化定位/修复”，绝不能因为 replay 失败、缺任务清单、步骤较多或新需求相似，就先 patrol_delete、patrol_remove_steps、patrol_delete_step 或 patrol_rewrite_flow_path 清空/重写旧流程。需要任何删除、清空、批量移除或重写步骤时，必须调用 patrol_request_flow_change_choice 弹出原生三选一卡片，让用户选择：① 确定（允许一次） ② 新建一份流程图 ③ 总是确定。只有卡片返回选择后才能继续；若当前客户端不支持卡片，才退回相同三个选项的纯文本询问，并在用户明确回答后调用 patrol_flow_change_choice。
- 用户选择“确定（允许一次）”后只授权一次破坏性工具调用；用户选择“新建一份流程图”后必须保留旧流程原样并使用新的 inspectionId；用户选择“总是确定”仅对当前 inspectionId、当前 Harness 进程有效，不得把这个偏好持久化到未来重启后的会话。
- 一个清单步骤只有获得 CURRENT 可观察证据后才能标记完成。工具仅返回 ok、页面标题相似、URL 猜测或“看起来像工作台”都不是业务完成证据。若用户说明“出现侧栏才算点击工作台成功”，必须以侧栏/目标菜单的真实出现作为成功证据。
- 必需业务步骤遇到扩展能力缺失、页面加载、iframe 重建或 selector 失效且尚未发生物理点击时，先取得新的 CURRENT 证据并走受控恢复，不得把工具调用次数误算成业务失败。若物理点击已发生但结果未验证，必须先确认 CURRENT 状态，且最多允许一次恢复点击；两次仍未验证就停止，避免重复提交或其他副作用。禁止跳过失败步骤制造“完成”的流程。
- DRAFT 教学轨迹可以包含诊断探针，但最终 Runbook 只能保留与任务清单一一对应且已验证成功的路线。失败点击、猜 URL、回退/重进、重复 wait/read/snapshot、诊断 probe、被后续修正覆盖的输入都属于教学轨迹，不属于最终可复用流程。
- 完成用户目标后必须使用 patrol_finalize_flow 只选择真正成功的 step id，再确认流程；没有完成任务清单中的全部必需项时不得确认 READY。清理按钮只能清理轨迹，不能把一个缺少关键业务动作的残缺 Flow 变成可用 Flow。
- 页面发生跳转/iframe 重建不允许让触发跳转的动作丢失。Patrol 应对页面变化做有界验证并保留已验证的因果点击。
- 不要直接调用会改变页面的 browser_*。browser_click 等是 DSH Patrol 内部执行 primitive；patrol_* 复合工具会在内部调用它们并负责唯一目标解析、验证、记录和重放。`

const BROWSER_STEP_TOOLS = new Set(['patrol_browser_step', 'patrol_reteach_browser_step'])
/**
 * Kept as a compatibility export for existing tests/importers. Click integrity
 * is implemented by the click composite itself (unique target + post-click
 * verification), so there is intentionally no pre-click expectedText block.
 */
export function patrolTeachingIntegrityGuard(_execution: any): string | undefined {
  return undefined
}

export function createPatrolTeachingIntegrityGuard() {
  const declaredTargets = new Map<string, string>()

  return (execution: any): string | undefined => {
    const name = String(execution?.name ?? '')
    const args = isRecord(execution?.arguments) ? execution.arguments : {}
    const inspectionId = typeof args.inspectionId === 'string' ? args.inspectionId.trim() : ''

    if (inspectionId && name === 'patrol_create_draft' && typeof args.targetUrl === 'string') {
      const identity = navigationIdentity(args.targetUrl)
      if (identity) declaredTargets.set(inspectionId, identity)
      return undefined
    }

    if (inspectionId && name === 'patrol_set_task_checklist') {
      return undefined
    }

    // Do not let an Agent bypass the navigation lock by changing the target to
    // its own guessed internal URL. Metadata updates that keep the same target
    // remain allowed. A real target change requires an explicit new/recreated
    // flow, which is observable to the user and starts a fresh contract.
    if (inspectionId && name === 'patrol_update_inspection' && typeof args.targetUrl === 'string') {
      const identity = navigationIdentity(args.targetUrl)
      const declared = declaredTargets.get(inspectionId)
      if (declared && identity && identity !== declared) {
        return [
          'DSH Patrol target integrity guard: targetUrl change was NOT executed.',
          `This teaching flow is locked to ${JSON.stringify(declared)}; requested replacement was ${JSON.stringify(identity)}.`,
          'Do not rewrite targetUrl to bypass a failed CURRENT-page click. If the user explicitly changed the top-level patrol target, delete/clear and recreate the DRAFT with that target.',
        ].join(' ')
      }
      if (!declared && identity) declaredTargets.set(inspectionId, identity)
      return undefined
    }

    if (inspectionId && (name === 'patrol_delete' || name === 'patrol_delete_flow')) {
      declaredTargets.delete(inspectionId)
      return undefined
    }

    if (!inspectionId) return undefined
    const declared = declaredTargets.get(inspectionId)
    if (!declared) return undefined

    let requestedUrl = ''
    if (name === 'patrol_navigate' && typeof args.url === 'string') requestedUrl = args.url
    else if (BROWSER_STEP_TOOLS.has(name) && args.action === 'navigate' && isRecord(args.arguments) && typeof args.arguments.url === 'string') {
      requestedUrl = args.arguments.url
    }
    if (!requestedUrl) return undefined

    const requested = navigationIdentity(requestedUrl)
    if (!requested || requested === declared) return undefined
    return [
      'DSH Patrol navigation integrity guard: navigation was NOT executed.',
      `This DRAFT declared target ${JSON.stringify(declared)}, but the requested navigation is ${JSON.stringify(requested)}.`,
      'Do not guess an internal URL to bypass a failed click. Repair the required CURRENT-page action instead. A different top-level target requires an explicitly recreated flow.',
    ].join(' ')
  }
}

export function registerPatrolIntegrity(ctx: Context): () => void {
  let disposePrompt: (() => void) | undefined
  try {
    const systemPrompt = ctx.get('systemPrompt') as { section?: (input: { name: string; order: number; text: string }) => (() => void) } | undefined
    if (typeof systemPrompt?.section === 'function') {
      disposePrompt = systemPrompt.section({
        name: 'agent:dsh-patrol-reusable-flow-integrity',
        order: 1100,
        text: PATROL_INTEGRITY_PROMPT,
      })
    }
  } catch {
  }

  const mutationConsent = createFlowMutationConsentController(ctx)
  const disposeChoiceTools: Array<() => void> = []
  try {
    disposeChoiceTools.push(ctx.tools.register(mutationConsent.requestChoiceTool))
    disposeChoiceTools.push(ctx.tools.register(mutationConsent.choiceTool))
  } catch {
    for (const dispose of disposeChoiceTools.splice(0)) {
      try { dispose() } catch {}
    }
  }

  let disposeGuard: (() => void) | undefined
  try {
    const tools = (ctx as Context & { tools?: { guard?: (callback: (execution: any) => string | undefined) => (() => void) } }).tools
    if (typeof tools?.guard === 'function') {
      const integrityGuard = createPatrolTeachingIntegrityGuard()
      disposeGuard = tools.guard(execution => mutationConsent.guard(execution) ?? integrityGuard(execution))
    }
  } catch {
  }

  return () => {
    try { disposeGuard?.() } catch {}
    for (const dispose of disposeChoiceTools.splice(0)) {
      try { dispose() } catch {}
    }
    try { disposePrompt?.() } catch {}
  }
}

function navigationIdentity(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return ''
  try {
    const url = new URL(text)
    url.hash = ''
    url.search = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return text.split('#')[0]!.split('?')[0]!.replace(/\/$/, '')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
