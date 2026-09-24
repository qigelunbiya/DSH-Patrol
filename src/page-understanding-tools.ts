import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { assertSafePersistentText, redactLikelySecrets } from './security.js'
import type { PatrolRunner } from './runner.js'
import type { PatrolStore } from './store.js'
import { createPatrolClickOutcomeTracker, type PatrolClickOutcomeTracker } from './click-retry-state.js'

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

const STATE_TTL_MS = 3 * 60_000
const CLICK_TOOLS = new Set(['patrol_click', 'patrol_click_target'])
const CSS_SELECTOR_TOOLS = new Set([
  'patrol_click', 'patrol_click_target',
  'browser_click', 'browser_count', 'browser_snapshot', 'browser_read_page', 'browser_wait',
])
const PHASE_PROGRESS_TOOLS = new Set([
  'patrol_navigate', 'patrol_type', 'patrol_type_text', 'patrol_type_focused_text', 'patrol_type_transient',
  'patrol_type_credential', 'patrol_type_totp_profile', 'patrol_select', 'patrol_press',
  'patrol_resume', 'patrol_resume_validation', 'patrol_run', 'patrol_run_flow',
])

const RESET_EPISODE_TOOLS = new Set([
  'patrol_create_draft',
  'patrol_create_inspection',
  'patrol_begin_edit',
  'patrol_update_inspection',
  'patrol_set_task_checklist',
  'patrol_delete',
  'patrol_reteach_text',
  'patrol_reteach_credential',
  'patrol_reteach_transient',
  'patrol_reteach_browser_step',
  'patrol_reteach_checkpoint',
])

interface PlanningGuardState {
  touchedAt: number
  businessKey: string
}

interface SnapshotElement {
  selector: string
  text: string
  role: string
  tag: string
}

export interface PageUnderstandingPlan {
  kind: 'structured-row' | 'semantic' | 'stable-selector' | 'no-unique-target'
  selector?: string | undefined
  locatorText?: string | undefined
  evidence: string
}

export const PATROL_PAGE_UNDERSTANDING_PROMPT = `DSH Patrol 页面理解与执行规划（NORMAL/TEST MODE 都必须遵守）：
- taskChecklist 只描述业务动作；执行页面动作前，要根据 CURRENT DOM/iframe/modal/structured table/视觉页面判断真实前端结构，不要把用户文字直接翻译成 nth-of-type 后盲点。
- 浏览器操作方法首先服从用户最近一条明确指令：用户未指定方法时，DOM/semantic、CURRENT selector、浏览器视觉都可按 CURRENT 证据选择，不规定固定优先级；用户明确要求只用视觉时，业务点击只允许 patrol_browser_click_ocr_text 或 patrol_observe(includeImage=true) → patrol_browser_visual_action_map → read_image → patrol_browser_click_visual_candidate，禁止 patrol_click_target/selector 代打；用户明确禁止视觉时，不得 includeImage=true，也不得调用 patrol_browser_visual_action_map、patrol_browser_click_visual_candidate、patrol_browser_click_ocr_text 等视觉工具。
- patrol_analyze_step 永远不写 Runbook。需要表格行身份、弹窗上下文、iframe 或同名目标消歧时，它会把“行身份 + 行内动作”绑定，例如“目标地址 + RDP”。不要把分析器给出的 selector 再扩写成更长的 nth-of-type，也不要在没有新证据时连续猜 selector。
- 对“某一行身份 + 行内动作”的表格目标（例如“10.192.3.174 这一行的 RDP/SSH”），用户未指定方法时仍优先 patrol_click_target 的 CURRENT row-context resolver。若用户明确只用视觉：行内动作文字唯一可见时优先 patrol_browser_click_ocr_text(text="RDP")；如果同页多个 RDP 造成 OCR 歧义，则先用完整 CURRENT screenshot 识别目标行的大致区域，再 patrol_browser_visual_action_map 对该行局部生成 V#，read_image 确认该行对应的 V# 后 patrol_browser_click_visual_candidate。禁止 A#/B#/整页自由 XY。
- selector 只接受当前浏览器 querySelector 层支持的 CSS。严禁 jQuery/Playwright/XPath 方言：:contains(...)、:has-text(...)、text=...、//...、.//...、xpath=...。locatorText 已知时优先只传 locatorText 给 patrol_click_target；若 locatorText 已提供但 selector hint 是非法方言，运行时会丢弃这个可选 hint 而继续语义定位。
- 一种方法失败不会锁死其他方法。DOM/semantic 未命中后可以切换视觉，视觉未命中后也可以回到 DOM/semantic；不要为了满足固定次数而重复 analyze/read/snapshot 或编造 CSS。页面规划器不再使用视觉点击次数、失败次数或物理点击预算做 HARD STOP；需要继续尝试时可以继续。已经有证据确认开关型业务点击成功后，模型应根据 CURRENT 状态主动避免再次点击把状态反向切回，而不是依赖次数锁死工具。
- 浏览器视觉 PRIMARY grounding 现在与应用巡检工作流对齐，但实现完全独立：可见文字走 patrol_browser_click_ocr_text（fresh browser screenshot + Windows OCR bbox center）；无文字控件走完整 CURRENT browser screenshot → patrol_browser_visual_action_map（Browser 自己的 Desktop-style edge/component Action Map）→ read_image → patrol_browser_click_visual_candidate(V#)。模型只负责从截图/Action Map 判断目标和选择 V#，最终 click geometry 永远由程序 bbox center 产生。旧 pixelCandidateId=B#、candidateId=A#、focused crop、previewId、manual imageX/imageY、xRatio/yRatio 只保留历史兼容，不得作为 TEST 新教学恢复路线。Browser visual plane 与 Desktop visual plane 必须彻底隔离。
- 视觉截图不设固定次数上限。模型可以在页面/滚动/布局变化后按需重新 patrol_observe(includeImage=true) 获取新的 CURRENT frame；每次新视觉附件前 Patrol 会通过 Harness image/offload 把旧工具图片移出模型可见输入，并单独裁剪过大的文本工具结果，同时保持 DPR-aware 的有界截图尺寸，避免旧图片堆积把本地 Qwen 推到 CUDA OOM / 503。不要无状态变化地机械重复同一张截图，但不得因为“已经看过两次”而阻止真正需要的新视觉观察。
- 教学成功后的 browser_visual_click 会反向学习 visual hit 对应的 semantic locator / stable selector；重放顺序是 learned semantic → learned selector → guarded visual geometry。用户明确要求视觉专用的教学轮次可以纯视觉完成复杂 UI，但未来无人值守重放仍优先复用已学习到的稳定语义/DOM 身份。所有方法都必须以 CURRENT 业务状态验证为准，不能仅因为工具发出了 click 就宣称成功。
- 不要为每个内部工具调用向用户重复“我再观察一下/我再试一下/让我换个选择器”。只有需要用户输入/确认、遇到不可恢复阻塞、或任务最终完成时才发自然语言说明。任何没有新工具结果或新页面证据支持的 selector 推测最多写一次。
- 教学轨迹不等于 Runbook。诊断 snapshot/read、失败点击、重复输入、临时等待都不是最终流程。任务完成后必须 patrol_finalize_flow，只保留真正完成 taskChecklist 的已验证业务路径，再确认流程。
- targetUrl/browser_navigate 必须是纯 http/https URL。若对话渲染成 Markdown 链接 [url](url)，还原 href 后再调用工具，禁止把 Markdown 链接字符串写进 Flow JSON。
- 图片字符验证码不走通用页面点击规划器。TEST MODE 必须先调用 patrol_solve_current_image_code，让 browser_detect_auth_challenge 走 Windows OCR/本地 OCR；只有明确 testModeFallback=true / strategy=model-visual-test 并拿到一次性 fallbackToken 时才允许 browser_capture_image_code_visual。没有 fallbackToken 时禁止模型视觉验证码。NORMAL/无人值守重放继续使用动态本地 solver。OTP/TOTP 继续走专用工具。`

/** Always-on in NORMAL and TEST MODE: syntax/resource safety without method-order policy. */
function createStrategyNeutralPlanningGuard(outcomes: PatrolClickOutcomeTracker, testMode = false) {
  const states = new Map<string, PlanningGuardState>()
  return (execution: any): string | undefined => {
    const name = String(execution?.name ?? '')
    const args = isRecord(execution?.arguments) ? execution.arguments : {}
    const selectorIssue = unsupportedSelectorSyntax(name, args)
    if (selectorIssue !== undefined) return selectorIssue
    if (!name.startsWith('patrol_')) return undefined

    const urlIssue = malformedPatrolUrl(name, args)
    if (urlIssue !== undefined) return urlIssue
    const inspectionId = cleanString(args.inspectionId)
    if (!inspectionId) return undefined

    const now = Date.now()
    for (const [key, value] of states) if (now - value.touchedAt > STATE_TTL_MS) states.delete(key)
    let state = states.get(inspectionId)
    if (state === undefined) {
      state = { touchedAt: now, businessKey: '' }
      states.set(inspectionId, state)
    }
    state.touchedAt = now

    if (RESET_EPISODE_TOOLS.has(name) || PHASE_PROGRESS_TOOLS.has(name)) {
      outcomes.clearInspection(inspectionId)
      states.delete(inspectionId)
      return undefined
    }

    if (name === 'patrol_analyze_step') {
      alignBusinessState(state, businessKey(args.task, args.locatorText))
      return undefined
    }

    if (name === 'patrol_observe' && args.includeImage === true) {
      if (testMode && (args.pixelActionMap === true || args.actionMap === true)) {
        return [
          'DSH Patrol TEST 视觉策略保护：旧 A#/B# Action Map 不再用于新的浏览器视觉教学。',
          '可见文字直接使用 patrol_browser_click_ocr_text。',
          '无文字控件先普通 patrol_observe(includeImage=true) 获取 clean full CURRENT frame，再 patrol_browser_visual_action_map → read_image → patrol_browser_click_visual_candidate(V#)。',
        ].join(' ')
      }
      // No fixed screenshot-count ceiling. Local-Qwen stability is handled by
      // bounded raster size plus proactive pruning of older Patrol tool/image
      // payloads before the next visual attachment.
      return undefined
    }

    if (name === 'patrol_visual_click_target') {
      if (testMode) {
        return [
          'DSH Patrol TEST 浏览器视觉入口已更新：不要直接调用 patrol_visual_click_target。',
          '可见文字使用 patrol_browser_click_ocr_text；无文字控件使用 patrol_observe(includeImage=true) → patrol_browser_visual_action_map → read_image → patrol_browser_click_visual_candidate。',
          '旧 A#/B#/imageX/imageY/xRatio/yRatio/previewId 只保留历史兼容。',
        ].join(' ')
      }
      const rowVisualIssue = structuredRowFreePointIssue(args)
      if (rowVisualIssue !== undefined) return rowVisualIssue
      // Visual teaching/recovery is intentionally not count-gated. A model may
      // reuse the same CURRENT frame and retry coordinates as many times as
      // needed. Safety comes from CURRENT page/geometry validation plus
      // post-click business-state verification, not from an attempt counter.
      alignBusinessState(state, businessKey(args.stepName, undefined))
      return undefined
    }

    if (CLICK_TOOLS.has(name)) {
      alignBusinessState(state, businessKey(args.stepName, args.locatorText))
      return undefined
    }

    return undefined
  }
}

export function createPatrolTestModePlanningGuard(outcomes: PatrolClickOutcomeTracker = createPatrolClickOutcomeTracker()) {
  return createStrategyNeutralPlanningGuard(outcomes, true)
}

export function createPatrolPlanningGuard(outcomes: PatrolClickOutcomeTracker = createPatrolClickOutcomeTracker()) {
  return createStrategyNeutralPlanningGuard(outcomes, false)
}

function structuredRowFreePointIssue(args: Record<string, unknown>): string | undefined {
  const context = [cleanString(args.stepName), cleanString(args.targetHint), cleanString(args.expectedVisualText)]
    .filter(Boolean)
    .join(' ')
  const identity = context.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/)?.[0]
  const action = context.match(/\b(RDP|SSH|VNC|SFTP|FTP|HTTPS?)\b/i)?.[1]?.toUpperCase()
  if (!identity || !action) return undefined
  return [
    'DSH Patrol structured-row precision guard：本次旧视觉点击未执行。',
    `目标同时包含行身份 ${identity} 和行内动作 ${action}。不要从整页自由坐标、A# 或 B# 猜相邻行。`,
    `用户未指定操作方法时，使用 patrol_click_target：stepName 保留“${identity} 行的 ${action}”，locatorText=${JSON.stringify(action)}，让 CURRENT row-context resolver 绑定正确逻辑行。`,
    `若用户明确要求只用视觉：若 CURRENT 截图里 ${action} 唯一可见，使用 patrol_browser_click_ocr_text(text=${JSON.stringify(action)})；若存在多个同名动作，则先用 full CURRENT screenshot 判断目标行粗区域，再 patrol_browser_visual_action_map → read_image → patrol_browser_click_visual_candidate(V#)。不得回到 A#/B#/XY。`,
  ].join(' ')
}

function unsupportedSelectorSyntax(name: string, args: Record<string, unknown>): string | undefined {
  if (!CSS_SELECTOR_TOOLS.has(name)) return undefined
  const selector = cleanString(args.selector)
  if (!selector) return undefined
  const unsupported = /:(?:contains|has-text)\s*\(/i.test(selector)
    || /^text\s*=/i.test(selector)
    || /^(?:xpath\s*=|\/\/|\.\/\/)/i.test(selector)
  if (!unsupported) return undefined
  // patrol_click_target treats selector as an optional hint when locatorText is
  // present. Let the tool discard a bad hint and continue through semantic /
  // exact-title resolution instead of blocking the whole business click.
  if (name === 'patrol_click_target' && cleanString(args.locatorText)) return undefined
  return [
    'DSH Patrol selector 语法保护：本次调用未执行。',
    `当前浏览器 selector 层只接受 CSS，拒绝不支持的 selector ${JSON.stringify(selector)}。`,
    '不要使用 :contains(...), :has-text(...), text=..., XPath //..././/...；请使用 CURRENT snapshot/analyze 返回的 CSS（例如唯一的 [title="..."]）。',
    '该非法 selector 不会消耗或锁死任何视觉/业务点击次数；修正定位后可继续尝试。',
  ].join(' ')
}

function alignBusinessState(state: PlanningGuardState, key: string): void {
  if (!key || state.businessKey === key) return
  if (state.businessKey && (state.businessKey.includes(key) || key.includes(state.businessKey))) return
  state.businessKey = key
}

function businessKey(primary: unknown, locator: unknown): string {
  // stepName/taskChecklist text is the stable business identity. locatorText is
  // only a DOM hint and may legitimately change during recovery.
  const raw = cleanString(primary) || cleanString(locator) || 'click'
  return normalize(raw)
    .replace(/^(?:请)?(?:点击|打开|选择|进入|查看|访问|尝试)+/g, '')
    .replace(/(?:节点|菜单项|菜单|选项)$/g, '')
    .replace(/\d{6,}/g, '#')
    .slice(0, 220)
}

export function registerPatrolPageUnderstandingTools(
  ctx: Context,
  store: PatrolStore,
  runner: PatrolRunner,
  clickOutcomes?: PatrolClickOutcomeTracker,
): () => void {
  const analyze = defineTool({
    name: 'patrol_analyze_step',
    description: 'Read-only CURRENT-page planner. Correlates DOM, iframe/modal evidence and structured table rows with one taskChecklist action and returns evidence-backed plans. Never records a Runbook step and never solves image-code CAPTCHA.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      task: { type: 'string', required: true, description: 'One atomic business action from taskChecklist.' },
      locatorText: { type: 'string', description: 'Optional visible target text already known from user/CURRENT evidence.' },
      tabId: { type: 'integer' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec: ToolRunContext) {
      assertSafePersistentText(args.task, 'page understanding task')
      if (args.locatorText !== undefined) assertSafePersistentText(args.locatorText, 'page understanding locatorText')
      await store.load(args.inspectionId)
      const base = args.tabId === undefined ? {} : { tabId: args.tabId }
      const [snapshot, page, exactTitle] = await Promise.all([
        runner.dispatch('browser_snapshot', { ...base, maxElements: 500, includeHidden: false }, exec),
        runner.dispatch('browser_read_page', { ...base, maxChars: 24000 }, exec),
        args.locatorText
          ? runner.dispatch('browser_count', {
              ...base,
              selector: exactTitleSelector(args.locatorText),
              visibleOnly: true,
            }, exec)
          : Promise.resolve(undefined),
      ])
      if (!snapshot.ok && !page.ok) {
        throw new Error(`CURRENT page analysis failed: snapshot=${snapshot.error ?? 'unavailable'}; readPage=${page.error ?? 'unavailable'}`)
      }
      const exactCount = exactTitle?.ok ? objectNumber(exactTitle.value, 'count') : undefined
      const plans = exactCount === 1 && args.locatorText
        ? [{
            kind: 'semantic' as const,
            selector: exactTitleSelector(args.locatorText),
            locatorText: args.locatorText,
            evidence: `CURRENT top-frame exact title is uniquely visible: ${JSON.stringify(args.locatorText)}. Click the titled leaf; browser_click will promote it to its own Ant-tree content wrapper when applicable.`,
          }]
        : analyzePageEvidence(
            args.task,
            args.locatorText,
            objectString(page.value, 'text') ?? page.text ?? '',
            snapshotElements(snapshot.value),
          )
      const hasConcreteDomPlan = plans.some(plan => plan.kind !== 'no-unique-target' && typeof plan.selector === 'string' && plan.selector.length > 0)
      clickOutcomes?.setVisualFallbackAuthorization({
        inspectionId: args.inspectionId,
        stepName: args.task,
        locatorText: args.locatorText,
      }, !hasConcreteDomPlan)
      return renderUnderstanding(
        args.task,
        objectString(snapshot.value, 'url') ?? objectString(page.value, 'url') ?? '',
        objectString(snapshot.value, 'title') ?? objectString(page.value, 'title') ?? '',
        objectBoolean(snapshot.value, 'foregroundModal') === true,
        plans,
      )
    },
  })
  return ctx.tools.register(analyze)
}

export function analyzePageEvidence(task: string, locatorText: string | undefined, pageText: string, elements: readonly SnapshotElement[]): PageUnderstandingPlan[] {
  const tokens = importantTaskTokens(task, locatorText)
  const plans: PageUnderstandingPlan[] = []
  const row = structuredRowPlan(pageText, tokens)
  if (row) plans.push(row)

  const candidates = rankDomCandidates(elements, tokens, locatorText)
  if (candidates.length === 1) {
    const candidate = candidates[0]!
    plans.push({
      kind: 'semantic', selector: candidate.selector,
      ...(candidate.text || locatorText ? { locatorText: candidate.text || locatorText } : {}),
      evidence: `CURRENT DOM 唯一高相关目标 <${candidate.tag || '?'}>${candidate.role ? ` role=${candidate.role}` : ''} text=${JSON.stringify(short(candidate.text, 100))}`,
    })
  } else if (candidates.length > 1 && plans.length === 0) {
    plans.push({ kind: 'no-unique-target', evidence: `CURRENT DOM 有 ${candidates.length} 个同等相关候选，不能只按文本盲点；需要行身份、弹窗上下文或更具体的 CURRENT selector。` })
  }
  if (plans.length === 0) {
    plans.push({ kind: 'no-unique-target', evidence: 'CURRENT DOM/structured table 没有足够唯一的目标。不要猜内部 URL 或 nth-of-type；应停止并报告缺少的页面证据。' })
  }
  return dedupePlans(plans).slice(0, 3)
}

function structuredRowPlan(pageText: string, tokens: readonly string[]): PageUnderstandingPlan | undefined {
  const rows = pageText.split(/\r?\n/).map(line => line.trim()).filter(line => /^Row\s+\d+:/i.test(line))
  const identities = tokens.filter(token => /\d{1,3}(?:\.\d{1,3}){3}/.test(token) || (/\d/.test(token) && token.length >= 4))
  const actions = tokens.filter(token => /^(rdp|ssh|vnc|sftp|ftp|https?|打开|登录|详情|访问)$/i.test(token))
  const scored = rows.map(row => {
    const normalized = normalize(row)
    const selectors = extractClickSelectors(row)
    const action = selectors.find(entry => actions.some(token => normalize(entry.field).includes(normalize(token))))
    return {
      row,
      score: tokens.filter(token => normalized.includes(normalize(token))).length,
      identityMatched: identities.length === 0 || identities.every(token => normalized.includes(normalize(token))),
      selector: action?.selector ?? selectors[0]?.selector,
    }
  }).filter(item => item.identityMatched && item.selector)
  scored.sort((a, b) => b.score - a.score)
  if (!scored[0] || scored[0].score <= 0) return undefined
  const best = scored.filter(item => item.score === scored[0]!.score)
  if (best.length !== 1) return undefined
  const chosen = best[0]!
  if (!chosen.selector) return undefined
  return { kind: 'structured-row', selector: chosen.selector, evidence: `structured table 唯一匹配用户任务所在行：${short(chosen.row, 240)}` }
}

function extractClickSelectors(row: string): Array<{ field: string; selector: string }> {
  const out: Array<{ field: string; selector: string }> = []
  for (const field of row.split(' | ')) {
    const match = /\[click\s+"((?:\\.|[^"\\])*)"\]/.exec(field)
    if (!match) continue
    let selector = match[1] ?? ''
    try { selector = JSON.parse(`"${selector}"`) } catch {}
    if (selector) out.push({ field, selector })
  }
  return out
}

function rankDomCandidates(elements: readonly SnapshotElement[], tokens: readonly string[], locatorText?: string): SnapshotElement[] {
  const wanted = normalize(locatorText || '')
  const exactTitle = wanted
    ? elements.filter(element =>
        normalize(element.text) === wanted
        && /\[title=(?:"|')/i.test(element.selector),
      )
    : []
  const pool = exactTitle.length > 0 ? exactTitle : elements
  const deduped = new Map<string, SnapshotElement>()
  for (const element of pool) {
    const key = exactTitle.length > 0 ? `${normalize(element.text)}|${normalizeTitleSelector(element.selector)}` : element.selector
    const existing = deduped.get(key)
    if (existing === undefined || stableSelectorScore(element.selector) > stableSelectorScore(existing.selector)) deduped.set(key, element)
  }
  const scored = [...deduped.values()].map(element => {
    const haystack = normalize(`${element.text} ${element.selector} ${element.role} ${element.tag}`)
    let score = wanted && normalize(element.text) === wanted ? 100 : wanted && normalize(element.text).includes(wanted) ? 40 : 0
    score += tokens.filter(token => haystack.includes(normalize(token))).length * 8
    if (['button', 'a', 'input'].includes(element.tag)) score += 4
    if (['button', 'link', 'menuitem'].includes(element.role)) score += 3
    if (wanted && normalize(element.text) === wanted && /\[title=/.test(element.selector)) score += 30
    if (/\[data-(?:testid|test|cy)=|#[A-Za-z_]|\[name=|\[aria-|\[title=/i.test(element.selector)) score += 2
    return { element, score }
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score)
  if (!scored[0]) return []
  return scored.filter(item => item.score === scored[0]!.score).slice(0, 8).map(item => item.element)
}

function normalizeTitleSelector(selector: string): string {
  const match = /\[title=(?:"([^"]+)"|'([^']+)')\]/i.exec(selector)
  return normalize(match?.[1] || match?.[2] || selector)
}

function stableSelectorScore(selector: string): number {
  let score = 0
  if (/\[title=/.test(selector)) score += 20
  if (/\.new_tree_box\b/.test(selector)) score += 12
  if (/top-frame::/.test(selector)) score += 2
  score -= Math.min(10, selector.split('>').length)
  return score
}

function importantTaskTokens(task: string, locatorText?: string): string[] {
  const out = new Set<string>()
  if (locatorText?.trim()) out.add(locatorText.trim())
  for (const match of task.matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g)) out.add(match[0])
  for (const match of task.matchAll(/\b(?:RDP|SSH|VNC|SFTP|FTP|HTTP|HTTPS)\b/gi)) out.add(match[0].toUpperCase())
  for (const phrase of ['登录', '确定', '提交', '打开', '访问', '详情', '工作台', '主机运维', '待办待阅工单', '运维']) if (task.includes(phrase)) out.add(phrase)
  return [...out]
}

function snapshotElements(value: unknown): SnapshotElement[] {
  if (!isRecord(value) || !Array.isArray(value.elements)) return []
  return value.elements.flatMap(raw => {
    if (!isRecord(raw)) return []
    const selector = cleanString(raw.selector)
    if (!selector) return []
    return [{ selector, text: cleanString(raw.text), role: cleanString(raw.role).toLowerCase(), tag: cleanString(raw.tag).toLowerCase() }]
  })
}

function renderUnderstanding(task: string, url: string, title: string, modal: boolean, plans: readonly PageUnderstandingPlan[]): string {
  const lines = [
    'CURRENT PAGE UNDERSTANDING',
    `业务动作：${task}`,
    `页面：${title || '(untitled)'}${url ? ` - ${safeUrl(url)}` : ''}`,
    `上下文：${modal ? '前景 modal/dialog（优先只操作弹窗内控件）' : '普通页面/iframe/structured table 联合分析'}`,
    'CURRENT 证据支持的执行方案：',
  ]
  plans.forEach((plan, index) => {
    lines.push(`${String.fromCharCode(65 + index)}. ${plan.kind}${plan.selector ? ` selector=${JSON.stringify(plan.selector)}` : ''}${plan.locatorText ? ` locatorText=${JSON.stringify(plan.locatorText)}` : ''}`)
    lines.push(`   证据：${redactLikelySecrets(plan.evidence)}`)
  })
  const hasConcreteDomPlan = plans.some(plan => plan.kind !== 'no-unique-target' && typeof plan.selector === 'string' && plan.selector.length > 0)
  lines.push(hasConcreteDomPlan
    ? 'CURRENT analyze 已提供可用 DOM 方案；这是一个可选的高置信执行路径，不构成视觉禁令。模型可结合 CURRENT 页面结构决定直接使用该 DOM 方案，或在视觉布局更可靠时获取 includeImage=true 的 CURRENT frame 后执行 patrol_visual_click_target。'
    : 'CURRENT analyze 暂无可靠唯一 DOM 目标；可以直接获取 includeImage=true 的 CURRENT frame 进行视觉点击，也可以在获得新的 DOM/Accessibility 证据后回到 semantic/selector 路径。')
  lines.push('验证码例外：本理解器不识别验证码；TEST MODE 先走 patrol_solve_current_image_code 本地 OCR，只有明确 fallback + 一次性 token 才允许视觉。')
  return lines.join('\n')
}

function malformedPatrolUrl(name: string, args: Record<string, unknown>): string | undefined {
  let raw = ''
  if ((name === 'patrol_create_draft' || name === 'patrol_create_inspection') && typeof args.targetUrl === 'string') raw = args.targetUrl.trim()
  else if (name === 'patrol_navigate' && typeof args.url === 'string') raw = args.url.trim()
  const markdown = /^\[[^\]]*\]\((https?:\/\/[^)\s]+)\)$/i.exec(raw)
  if (!markdown) return undefined
  return `DSH Patrol URL 输入保护：检测到 Markdown 链接字符串，未执行。请仅使用纯 URL ${JSON.stringify(markdown[1])} 重试；不要把 [url](url) 写入 Flow JSON。`
}

function dedupePlans(plans: readonly PageUnderstandingPlan[]): PageUnderstandingPlan[] {
  const seen = new Set<string>()
  return plans.filter(plan => {
    const key = `${plan.kind}|${plan.selector ?? ''}|${plan.locatorText ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function safeUrl(value: string): string {
  try {
    const url = new URL(value)
    url.username = ''; url.password = ''; url.search = ''; url.hash = ''
    return url.toString()
  } catch { return short(value.split(/[?#]/, 1)[0] ?? value, 240) }
}
function objectString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined
  const child = value[key]
  return typeof child === 'string' && child.length > 0 ? child : undefined
}
function objectBoolean(value: unknown, key: string): boolean | undefined {
  return isRecord(value) && typeof value[key] === 'boolean' ? value[key] : undefined
}
function objectNumber(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined
  const child = value[key]
  return typeof child === 'number' && Number.isFinite(child) ? child : undefined
}
function cleanString(value: unknown): string { return typeof value === 'string' ? value.trim() : '' }
function exactTitleSelector(text: string): string {
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')
  return `top-frame::[title="${escaped}"]`
}

function normalize(value: string): string { return value.replace(/\s+/g, '').toLocaleLowerCase() }
function short(value: string, limit: number): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}
function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
