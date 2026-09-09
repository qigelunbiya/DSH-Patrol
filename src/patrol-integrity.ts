import type { Context } from '@deepseek-ai/cordis'

/**
 * Integrity rules that must stay active even when CAPTCHA test mode relaxes the
 * ordinary observation/recovery guards. These are not debugging preferences:
 * they define when a browser action is allowed to become a reusable Runbook.
 */
export const PATROL_INTEGRITY_PROMPT = `DSH Patrol 可复用流程完整性规则（NORMAL/TEST MODE 均强制生效，本节不得被测试模式放宽）：
- 创建新流程后，先把用户原始要求拆成按顺序的业务任务清单。清单必须覆盖用户明确要求的每一个导航、点击、输入、读取、截图和打开详情动作。之后只按这份清单推进，不得因为某一步困难而自行改写业务目标。
- 用户明确要求填写的字段必须拥有真实可重放的输入步骤。即使 CURRENT 页面已经自动填好用户名、工号或普通文本，也必须通过对应 patrol_* 输入工具规范化并记录；“这次页面碰巧预填”不能替代下一次重放所需动作。敏感值仍只保存安全引用，绝不保存明文。
- 每个业务点击必须通过 patrol_click_target（优先）或受记录的 patrol_click 执行，并且在执行前就提供 expectedText。expectedText 必须证明点击后的下一业务状态已经出现。禁止先点击、等页面跳转后才发现没记录；运行时会在缺少 expectedText 时直接阻止点击。
- 新建 DRAFT 的教学导航被运行时锁定到 create_draft 声明的 targetUrl。用户要求“点击某入口”时，不得用猜测 URL 的 patrol_navigate 代替该点击；若任务确实需要变更顶层目标地址，应先通过 patrol_update_inspection 显式更新 targetUrl，再教学对应导航。
- 一个清单步骤只有获得 CURRENT 可观察证据后才能标记完成：点击用 expectedText，输入用实际成功执行，读取/截图用对应成功产物。工具仅返回 ok、页面标题相似、或模型根据 URL 猜测都不是业务完成证据。
- 同一必需业务步骤采用同类策略失败一次后，允许基于新的 CURRENT 证据再尝试一次；第二次仍失败必须停止本轮教学，明确告诉用户卡在哪一步、真实错误/页面证据是什么、需要用户提供什么协助。禁止跳过失败步骤继续制造“完成”的流程。
- DRAFT 教学轨迹可以包含诊断探针，但最终 Runbook 只能保留与任务清单一一对应且已验证成功的路线。失败点击、猜 URL、回退/重进、重复 wait/read/snapshot、诊断 probe、被后续修正覆盖的输入都属于教学轨迹，不属于最终可复用流程。
- 完成用户目标后必须使用 patrol_finalize_flow 只选择真正成功的 step id，再确认流程；没有完成任务清单中的全部必需项时不得确认 READY。
- 页面发生跳转/iframe 重建不允许让触发跳转的动作丢失。点击提交/登录必须先带 expectedText 执行，由 Patrol 在新页面可读后进行有界重试验证并记录该点击，再继续后续步骤。
- 不要直接调用会改变页面的 browser_*。browser_click 等是 DSH Patrol 内部执行 primitive；patrol_* 复合工具会在内部调用它们并负责唯一目标解析、验证、记录和重放。`

const CLICK_TOOLS = new Set(['patrol_click_target', 'patrol_click'])
const BROWSER_STEP_TOOLS = new Set(['patrol_browser_step', 'patrol_reteach_browser_step'])

export function patrolTeachingIntegrityGuard(execution: any): string | undefined {
  const name = String(execution?.name ?? '')
  const args = isRecord(execution?.arguments) ? execution.arguments : {}
  const isClick = CLICK_TOOLS.has(name)
    || (BROWSER_STEP_TOOLS.has(name) && args.action === 'click')
  if (!isClick) return undefined

  const expectedText = typeof args.expectedText === 'string' ? args.expectedText.trim() : ''
  if (expectedText) return undefined
  return [
    'DSH Patrol reusable-click integrity guard: the click was NOT executed.',
    'Every recorded business click requires expectedText before execution so a navigation/iframe replacement cannot make the causal click disappear from the Runbook.',
    'Re-run the same patrol click with an expectedText that proves the next business state (for example a menu item, page heading, table column, or other content that should appear after the click).',
  ].join(' ')
}

export function createPatrolTeachingIntegrityGuard() {
  const declaredTargets = new Map<string, string>()

  return (execution: any): string | undefined => {
    const name = String(execution?.name ?? '')
    const args = isRecord(execution?.arguments) ? execution.arguments : {}
    const inspectionId = typeof args.inspectionId === 'string' ? args.inspectionId.trim() : ''

    // Learn the declared user target from the creation/update operation itself.
    // This makes guessed same-origin paths impossible later in the same teaching
    // session without requiring an asynchronous store read inside ToolRuntime's
    // synchronous guard hook.
    if (inspectionId && name === 'patrol_create_draft' && typeof args.targetUrl === 'string') {
      const identity = navigationIdentity(args.targetUrl)
      if (identity) declaredTargets.set(inspectionId, identity)
      return undefined
    }
    if (inspectionId && name === 'patrol_update_inspection' && typeof args.targetUrl === 'string') {
      const identity = navigationIdentity(args.targetUrl)
      if (identity) declaredTargets.set(inspectionId, identity)
      return undefined
    }
    if (inspectionId && (name === 'patrol_delete' || name === 'patrol_delete_flow')) {
      declaredTargets.delete(inspectionId)
      return undefined
    }

    const clickError = patrolTeachingIntegrityGuard(execution)
    if (clickError !== undefined) return clickError

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
      'Do not guess an internal URL to bypass a failed click. Repair the required CURRENT-page click instead. If the user really changed the patrol target, call patrol_update_inspection with the new targetUrl first.',
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

  // Some isolated unit-test/minimal Cordis contexts intentionally omit the
  // dsh-tools service. The real Patrol preset always provides ctx.tools, so the
  // guard is still mandatory in production while model-recovery tests can use a
  // deliberately smaller context safely.
  let disposeGuard: (() => void) | undefined
  try {
    const tools = (ctx as Context & { tools?: { guard?: (callback: (execution: any) => string | undefined) => (() => void) } }).tools
    if (typeof tools?.guard === 'function') {
      const guard = createPatrolTeachingIntegrityGuard()
      disposeGuard = tools.guard(execution => guard(execution))
    }
  } catch {
  }

  return () => {
    try { disposeGuard?.() } catch {}
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
