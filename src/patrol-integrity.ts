import type { Context } from '@deepseek-ai/cordis'
import { createFlowMutationConsentController } from './flow-mutation-consent.js'
import { structuralEditAppendGuard } from './structural-edit-session.js'

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
- 新建 DRAFT 的顶层 targetUrl 是流程入口元数据，不是浏览器当前位置锁。正常巡检允许 patrol_navigate 在同一流程中访问后续已知 URL，也允许 action=back/forward/reload 恢复真实浏览器历史；但当用户明确要求“点击某入口”时，不得用模型猜测的内部 URL 替代该业务点击，也不得先调用 patrol_update_inspection 把猜测 URL 改成新 target 来伪造成功。
- 已有非空流程与当前用户描述不完全一致时，默认策略必须是“保留旧流程并做最小化定位/修复”，绝不能因为 replay 失败、缺任务清单、步骤较多或新需求相似，就先 patrol_delete、patrol_remove_steps、patrol_delete_step 或 patrol_rewrite_flow_path 清空/重写旧流程。
- 但是，如果 CURRENT 用户消息本身已经明确要求“旧流程删掉/清空/重建/重新创建”这类完整流程替换，不要再弹一遍确认卡造成死循环；直接对旧 inspection 调用 patrol_delete，并且 confirmed=true，然后按用户要求重新创建。patrol_delete 自身的 confirmed=true 就是完整流程删除的显式确认门槛。只有用户没有明确要求删除整个旧流程、而模型为了局部修复想删除/清理/批量移除/重写步骤时，才必须调用 patrol_request_flow_change_choice 弹出原生三选一卡片：① 确定（允许一次） ② 新建一份流程图 ③ 总是确定。
- 用户选择“确定（允许一次）”后只授权一次局部破坏性工具调用；用户选择“新建一份流程图”后必须保留旧流程原样并使用新的 inspectionId；用户选择“总是确定”仅对当前 inspectionId、当前 Harness 进程有效，不得把这个偏好持久化到未来重启后的会话。
- 一个清单步骤只有获得 CURRENT 可观察证据后才能标记完成。工具仅返回 ok、页面标题相似、URL 猜测或“看起来像工作台”都不是业务完成证据。若用户说明“出现侧栏才算点击工作台成功”，必须以侧栏/目标菜单的真实出现作为成功证据。
- 必需业务步骤遇到扩展能力缺失、页面加载、iframe 重建或 selector 失效且尚未发生物理点击时，先取得新的 CURRENT 证据并走受控恢复，不得把工具调用次数误算成业务失败。若物理点击已发生但结果未验证，必须先确认 CURRENT 状态，且最多允许一次恢复点击；两次仍未验证就停止，避免重复提交或其他副作用。禁止跳过失败步骤制造“完成”的流程。
- DRAFT 教学诊断轨迹可以保留所有真实尝试供排错，但可见 Runbook 从教学过程中就必须由 taskChecklist 实时约束，而不是等巡检结束再人工清理。失败点击、猜 URL、回退/重进、重复 Enter/wait/read/snapshot、诊断 probe、被后续成功操作覆盖的输入/点击都只能留在 diagnostic successfulTeachingTrace，不能继续占据 Runbook。复合清单项允许多个必要原子步骤，例如 type+提交、scroll+click。
- 完成用户目标后仍要使用 patrol_finalize_flow/validate 确认 taskChecklist 完整性，但此时 Runbook 应已经是实时筛选后的成功路线；不得从 successfulTeachingTrace 把已淘汰的重试、错误导航或重复操作重新恢复。没有完成任务清单中的全部必需原子动作时不得确认 READY。
- taskChecklist 是用户业务合同，不是为了让生成的流程通过校验而可自由改写的计数器。优化、清理、finalize、rewrite、validate 失败时，必须修 Runbook 去满足现有清单；禁止删除、改名、重排清单项来迁就残缺流程。patrol_update_task_checklist 的 scopeChangeConfirmed=true 只能在 CURRENT 用户明确改变、删除、改名或重排业务要求时使用；“流程图不完整/想优化/清除试错”本身不构成业务范围变更。
- 如果 patrol_click_target / patrol_visual_click_target 明确表示“物理点击已执行但 NOT recorded”，该业务项在 Runbook 中仍视为未沉淀完成。若紧接着的 CURRENT observe/read 明确证明用户要求的业务结果已经发生，不得直接跳到后续任务并在最后声称流程完整；必须在证据还新鲜时立即修复这一个记录缺口：优先 patrol_reconcile_successful_steps；若成功轨迹没有该动作但已有 replay-safe selector/locator 证据，则用结构编辑/单步重教补入正确位置；若没有足够可重放证据，就明确保持该 checklist 项缺失并只重教这一项。不得通过缩小 taskChecklist 掩盖记录缺口，也不得重复整个流程。
- patrol_finalize_flow / patrol_rewrite_flow_path / Dashboard 清除试错都必须以“逐项语义覆盖 taskChecklist”为完整性标准，而不只是比较导航/点击/输入数量。两个任意点击不能替代两个不同的用户业务点击；第二个站点导航、用户明确要求的 reload/scroll 也不能因为看起来像恢复动作就被自动删除。
- 用户要求修改一个已有流程图（补步骤、改步骤、移动步骤、删除步骤、修正参数、清除重复）时，无论该流程当前是 READY 还是 DRAFT，都必须先用 patrol_begin_edit 进入显式结构编辑隔离。进入后禁止 patrol_navigate / patrol_scroll / patrol_visual_click_target / patrol_click_target / patrol_screenshot / patrol_type_* / patrol_desktop_action 等“执行并追加教学步骤”的工具往尾部累加新轮次；已有流程修改只能用 patrol_insert_* / patrol_update_* / patrol_move_step / patrol_remove_steps，或对已存在 step 使用 patrol_reteach_*。如果只是缺一个业务动作，必须插入到 taskChecklist 对应的前后步骤之间，不得先重新跑后半段流程再回头补图。
- 页面发生跳转/iframe 重建不允许让触发跳转的动作丢失。Patrol 应对页面变化做有界验证并保留已验证的因果点击。
- 不要直接调用会改变页面的 browser_*。browser_click 等是 DSH Patrol 内部执行 primitive；patrol_* 复合工具会在内部调用它们并负责唯一目标解析、验证、记录和重放。`

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

    // targetUrl remains protected against silent metadata rewrites above, but
    // the CURRENT browser is intentionally free to navigate within a real
    // workflow. Navigation/back/forward/reload are ordinary recordable actions;
    // correctness is enforced by task/checklist evidence rather than by forcing
    // every page to equal the initial target URL.
    return undefined
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
      disposeGuard = tools.guard(execution =>
        mutationConsent.guard(execution)
        ?? structuralEditAppendGuard(execution)
        ?? integrityGuard(execution))
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
