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
  'patrol_navigate', 'patrol_type', 'patrol_type_text', 'patrol_type_transient',
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
  analyzed: boolean
  businessKey: string
  strategyAttempts: number
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
- taskChecklist 只描述业务动作；真正执行页面动作前，要根据 CURRENT DOM/iframe/modal/structured table 判断该业务动作对应的真实前端结构，不要把用户文字直接翻译成 nth-of-type 后盲点。
- 唯一且明显的文本目标可直接 patrol_click_target。第一次定位失败、出现 ambiguous、同名控件有多个、目标位于表格行/弹窗/iframe 时，调用一次 patrol_analyze_step 获取 CURRENT DOM 证据。若分析仍不能给出一个可可靠执行的唯一 DOM 目标，就不要为了凑“第二种策略”继续猜 CSS：只要已经有“一次 DOM/semantic 尝试 + 一次 CURRENT analyze”，就可以直接进入一次视觉模型后备。若分析确实给出了明确的第二种 DOM 方案，也可以先执行它；无论哪条路径，后续都禁止无限 selector 探索。视觉后备流程：patrol_observe(includeImage=true) → 读取真正的 visualFrameId → 按同一张图中控件中心给出 xRatio/yRatio → patrol_visual_click_target。
- patrol_analyze_step 永远不写 Runbook。它优先把“行身份 + 行内动作”绑定，例如“目标地址 + RDP”，避免只按 [RDP] 命中多行。不要把分析器给出的 selector 再扩写成更长的 nth-of-type，也不要在分析失败后继续 browser_count/snapshot/read_page 猜选择器。
- selector 参数只接受当前浏览器 querySelector 层支持的 CSS。严禁使用 jQuery/Playwright/XPath 方言：:contains(...)、:has-text(...)、text=...、//...、.//...、xpath=...。当 locatorText 已知时，优先只传 locatorText 给 patrol_click_target，不要额外猜 selector；patrol_click_target 会在 atomic semantic 失败时自动检查唯一 exact [title="..."]。如果 locatorText 已提供但 selector hint 是这些非法方言，运行时会丢弃这个可选 hint 而继续语义定位，不能让坏 hint 阻塞正确点击。title-backed 树节点若直接调用 selector，则只使用 CURRENT snapshot/analyze 给出的原生 CSS。
- 业务点击优先 patrol_click_target；若物理点击已发生但结果未验证，最多只允许一次有新证据支持的恢复点击；两次物理点击均未验证就 HARD STOP，避免重复提交。定位阶段只要已经完成一次 DOM/semantic 尝试并做过一次 CURRENT analyze、但仍没有可靠唯一目标，就允许进入单次视觉后备；不要求模型再编造一个 CSS 作为形式上的“第二种策略”。
- 视觉后备不是第三种 selector。patrol_visual_click_target 必须使用 patrol_observe(includeImage=true) 刚刚返回的 visualFrameId；底层验证 tab、URL、scroll、zoom、viewport 与截图一致才点击。若视觉调用在物理点击前失败（例如 stale frame、能力缺失、viewport 已变化），这次不消耗视觉物理点击预算，必须换一张 CURRENT 截图后再试；若已经发生物理视觉点击但业务状态仍未验证，最多只允许再有一次新截图/新证据支持的物理恢复。教学成功后保存为 browser_visual_click：重放优先使用视觉命中时发现的 stable selector；若 selector 漂移，再恢复记录的 URL/scroll/viewport 并使用归一化 xRatio/yRatio。
- 运行时若返回“DOM selector 策略已耗尽”，立即停止 patrol_analyze_step/patrol_click_target/patrol_click/browser_count/snapshot/read_page 的 selector 探索；只有 CURRENT 图片中明确可见目标时才走一次 patrol_observe(includeImage=true)+patrol_visual_click_target。视觉后备失败/未验证，或者已有两次未验证物理点击时才是最终 HARD STOP；此后必须直接结束当前 assistant turn。
- 不要为每个内部工具调用向用户重复“我再观察一下/我再试一下/让我换个选择器”。只有需要用户输入/确认、遇到不可恢复阻塞、或任务最终完成时才发自然语言说明。任何没有新工具结果或新页面证据支持的 selector 推测最多写一次。
- 教学轨迹不等于 Runbook。诊断 snapshot/read、失败点击、重复输入、临时等待都不是最终流程。任务完成后必须 patrol_finalize_flow，只保留真正完成 taskChecklist 的已验证业务路径，再确认流程。
- targetUrl/browser_navigate 必须是纯 http/https URL。若对话渲染成 Markdown 链接 [url](url)，还原 href 后再调用工具，禁止把 Markdown 链接字符串写进 Flow JSON。
- 图片字符验证码不走页面点击规划器。TEST MODE 必须先调用 patrol_solve_current_image_code，让 browser_detect_auth_challenge 走 Windows OCR/本地 OCR；只有明确 testModeFallback=true / strategy=model-visual-test 并拿到一次性 fallbackToken 时才允许 browser_capture_image_code_visual。没有 fallbackToken 时禁止模型视觉。NORMAL/无人值守重放继续使用动态本地 solver。OTP/TOTP 继续走专用工具。`

/** Always-on even in TEST MODE: bound model-facing retry strategies. */
export function createPatrolPlanningGuard(outcomes: PatrolClickOutcomeTracker = createPatrolClickOutcomeTracker()) {
  const states = new Map<string, PlanningGuardState>()
  return (execution: any): string | undefined => {
    const name = String(execution?.name ?? '')
    const args = isRecord(execution?.arguments) ? execution.arguments : {}
    const selectorIssue = unsupportedSelectorSyntax(name, args)
    if (selectorIssue !== undefined) return selectorIssue
    if (!name.startsWith('patrol_')) return undefined
    const inspectionId = cleanString(args.inspectionId)
    if (!inspectionId) return undefined

    const urlIssue = malformedPatrolUrl(name, args)
    if (urlIssue !== undefined) return urlIssue

    const now = Date.now()
    for (const [key, value] of states) if (now - value.touchedAt > STATE_TTL_MS) states.delete(key)
    let state = states.get(inspectionId)
    if (state === undefined) {
      state = { touchedAt: now, analyzed: false, businessKey: '', strategyAttempts: 0 }
      states.set(inspectionId, state)
    }
    state.touchedAt = now

    if (RESET_EPISODE_TOOLS.has(name)) {
      outcomes.clearInspection(inspectionId)
      states.delete(inspectionId)
      return undefined
    }
    if (PHASE_PROGRESS_TOOLS.has(name)) {
      outcomes.clearInspection(inspectionId)
      states.delete(inspectionId)
      return undefined
    }

    if (name === 'patrol_analyze_step') {
      const key = businessKey(args.task, args.locatorText)
      alignBusinessState(state, key)
      if (state.strategyAttempts >= 2) return visualFallbackStop()
      if (state.analyzed) {
        return 'DSH Patrol 页面规划器：CURRENT 分析已经为这个业务点击执行过一次。不要重复 analyze/read/snapshot/count；请执行分析给出的唯一恢复方案。'
      }
      state.analyzed = true
      return undefined
    }

    if (name === 'patrol_visual_click_target') {
      // targetHint is intentionally visual ("大拇指图标") and can differ from
      // the DOM locator text ("点赞"). Keep the retry episode bound to the
      // business stepName so a visual description cannot reset the strategy budget.
      const key = businessKey(args.stepName, undefined)
      alignBusinessState(state, key)
      const unverified = outcomes.unverifiedPhysicalClicks(args)
      const visualPhysical = outcomes.visualPhysicalClicks(args)
      if (unverified >= 2 || visualPhysical >= 2) {
        return strategyHardStop('同一业务动作已经发生两次未验证/视觉物理点击')
      }
      if (visualPhysical >= 1 && unverified === 0) {
        return strategyHardStop('这个业务目标已有一次已验证的视觉物理点击，禁止再次点击以免把点赞等开关状态反向切回')
      }
      const visualEligible = state.strategyAttempts >= 2
        || (state.strategyAttempts >= 1 && state.analyzed)
        || (visualPhysical >= 1 && unverified >= 1)
      if (!visualEligible) {
        return 'DSH Patrol 页面规划器：视觉点击需要先证明 DOM 路径无法可靠完成。至少先执行一次 patrol_click_target；若失败，再调用一次 patrol_analyze_step 获取 CURRENT DOM 证据。完成这两步后即可直接使用截图视觉后备，不需要为了凑“第二种策略”继续猜 CSS。'
      }
      // Do NOT consume the visual budget or clear analyzed evidence here.
      // The tool may still fail before any physical click (stale frame,
      // unsupported capability, viewport changed). Keeping CURRENT analysis
      // eligibility lets a fresh screenshot/frame retry without forcing the
      // model back into guessed CSS. The outcome tracker is updated only after
      // the browser confirms that a physical visual click actually executed.
      return undefined
    }

    if (!CLICK_TOOLS.has(name)) return undefined
    const key = businessKey(args.stepName, args.locatorText)
    alignBusinessState(state, key)
    const visualPhysical = outcomes.visualPhysicalClicks(args)
    const unverified = outcomes.unverifiedPhysicalClicks(args)
    if (visualPhysical >= 1 && unverified === 0) {
      return strategyHardStop('这个业务目标已有一次已验证的视觉物理点击，禁止重复 DOM 点击')
    }

    if (name === 'patrol_click_target') {
      if (unverified >= 2) return strategyHardStop('同一业务动作已有两次未验证的物理点击')
      if (state.strategyAttempts >= 2) return visualFallbackStop()
      if ((unverified === 1 || state.strategyAttempts === 1) && !state.analyzed) {
        return 'DSH Patrol 页面规划器：这个业务点击的第一种策略已经执行但没有形成可复用成功结果。本次点击未执行；只允许先调用一次 patrol_analyze_step 获取新的 CURRENT DOM 证据，然后执行最后一种 DOM 恢复策略。'
      }
      state.strategyAttempts += 1
      state.analyzed = false
      return undefined
    }

    if (state.strategyAttempts >= 2) return visualFallbackStop()
    if (!state.analyzed) {
      return 'DSH Patrol 页面规划器：不要直接猜 CSS。先调用 patrol_analyze_step，提供 taskChecklist 中当前业务动作，再基于 CURRENT DOM/iframe/modal/structured table 方案执行；也可直接使用会自行校验的 patrol_click_target。'
    }
    state.strategyAttempts += 1
    state.analyzed = false
    return undefined
  }
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
    '该非法 selector 不计入业务点击的两次策略预算。',
  ].join(' ')
}

function alignBusinessState(state: PlanningGuardState, key: string): void {
  if (!key || state.businessKey === key) return
  if (state.businessKey && (state.businessKey.includes(key) || key.includes(state.businessKey))) return
  state.businessKey = key
  state.analyzed = false
  state.strategyAttempts = 0
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

function visualFallbackStop(): string {
  return 'DSH Patrol 页面规划器：DOM selector 策略已耗尽。本次 selector 操作未继续执行；禁止再猜第三种 CSS/文本定位。如果 CURRENT 页面截图中明确可见目标，只允许 patrol_observe(includeImage=true) 获取一张新截图和 visualFrameId，然后执行一次 patrol_visual_click_target；否则停止并报告缺少视觉证据。'
}

function strategyHardStop(reason = '同一业务点击的安全恢复预算已耗尽'): string {
  return `DSH Patrol 页面规划器 HARD STOP：${reason}。本次操作未继续执行。禁止继续 DOM selector 或视觉坐标尝试；请报告当前页面无法安全完成该业务目标。`
}

export function registerPatrolPageUnderstandingTools(ctx: Context, store: PatrolStore, runner: PatrolRunner): () => void {
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
  lines.push('纪律：只执行一个最具体方案；若这是第一次失败后的恢复方案且仍失败，立即 HARD STOP，不再继续 selector 探索。')
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
