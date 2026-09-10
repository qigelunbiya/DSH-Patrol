import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { assertSafePersistentText, redactLikelySecrets } from './security.js'
import type { PatrolRunner } from './runner.js'
import type { PatrolStore } from './store.js'

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

const STATE_TTL_MS = 3 * 60_000
const MAX_SAME_BUSINESS_CLICK_ATTEMPTS = 2
const MAX_ANALYSES_WITHOUT_PROGRESS = 2

const CLICK_TOOLS = new Set(['patrol_click', 'patrol_click_target'])
const PHASE_PROGRESS_TOOLS = new Set([
  'patrol_navigate',
  'patrol_type',
  'patrol_type_text',
  'patrol_type_transient',
  'patrol_type_credential',
  'patrol_type_totp_profile',
  'patrol_select',
  'patrol_press',
  'patrol_resume',
  'patrol_resume_validation',
  'patrol_run',
  'patrol_run_flow',
])

interface PlanningGuardState {
  touchedAt: number
  analyses: number
  analyzed: boolean
  clickAttempts: Map<string, number>
}

interface SnapshotElement {
  selector: string
  text: string
  role: string
  tag: string
}

export interface PageUnderstandingPlan {
  kind: 'structured-row' | 'semantic' | 'stable-selector' | 'no-unique-target'
  selector?: string
  locatorText?: string
  evidence: string
}

export const PATROL_PAGE_UNDERSTANDING_PROMPT = `DSH Patrol 页面理解与执行规划（NORMAL/TEST MODE 都必须遵守）：
- 把用户任务分成两层：taskChecklist 只描述业务动作；真正执行每个页面动作前，先根据 CURRENT 页面结构决定“这个业务动作在当前 DOM/iframe/modal/table 中到底对应什么”。不要把用户文字直接翻译成 nth-of-type 选择器后盲点。
- 对唯一且明显的文本目标，可以直接使用 patrol_click_target。只要第一次定位失败、出现 ambiguous、同名控件有多个、目标位于表格行/弹窗/iframe，必须先调用 patrol_analyze_step，对 CURRENT snapshot + structured table + frame/modal 证据做一次只读分析，再按它给出的 A/B 方案执行。不要先堆 snapshot/read_page/wait 试探。
- patrol_analyze_step 是诊断/规划器，永远不写 Runbook。它会优先把“行身份 + 行内动作”绑定起来，例如“10.192.3.174 + RDP”，避免只按 [RDP] 文本命中多行。分析结果中的 selector 来自 CURRENT 页面证据，不允许模型继续自行扩写更长的 nth-of-type。
- 同一业务点击最多只有两个外部方案：第一次可以是直接语义点击；失败后必须重新理解页面，第二次必须使用新的 CURRENT 证据。第二次仍失败就停止并报告具体阻塞，不得在 patrol_click_target / patrol_click / observe / snapshot 之间循环换皮重试。
- 不要为每个内部工具调用向用户重复“我再观察一下/我再试一下/让我换个选择器”。工具链内部继续执行即可；只有需要用户输入/确认、遇到不可恢复阻塞、或任务最终完成时才发自然语言说明。
- 教学轨迹不等于 Runbook。snapshot、纯诊断 read、失败点击、重复输入、临时等待都不能因为“工具调用成功”就自动成为最终流程。完成任务后仍必须 patrol_finalize_flow，只保留真正完成 taskChecklist 的已验证业务路径，再确认流程。
- 这套理解器绝对不能替换图片字符验证码链路。image-code 继续使用现有 patrol_solve_current_image_code / ddddocr + Windows OCR 及其 CURRENT 裁图后备方案；不要因为页面理解器存在而重新识别、重复刷新或降低验证码置信度门槛。OTP/TOTP 也继续走现有专用工具。`

/**
 * Always-on outer loop breaker for model-facing click strategies. Unlike the
 * older recovery guard this is intentionally installed in TEST MODE too, since
 * TEST MODE is where long CAPTCHA/browser teaching conversations are exercised.
 */
export function createPatrolPlanningGuard() {
  const states = new Map<string, PlanningGuardState>()

  return (execution: any): string | undefined => {
    const name = String(execution?.name ?? '')
    if (!name.startsWith('patrol_')) return undefined
    const args = isRecord(execution?.arguments) ? execution.arguments : {}
    const inspectionId = cleanString(args.inspectionId)
    if (!inspectionId) return undefined

    const now = Date.now()
    cleanupGuardStates(states, now)
    let state = states.get(inspectionId)
    if (state === undefined) {
      state = { touchedAt: now, analyses: 0, analyzed: false, clickAttempts: new Map() }
      states.set(inspectionId, state)
    }
    state.touchedAt = now

    if (PHASE_PROGRESS_TOOLS.has(name)) {
      states.delete(inspectionId)
      return undefined
    }

    if (name === 'patrol_analyze_step') {
      if (state.analyses >= MAX_ANALYSES_WITHOUT_PROGRESS) {
        return 'DSH Patrol 页面规划器：当前页面阶段已经分析两次且没有新的业务进展。不要继续 analyze/observe/snapshot 循环；按已有方案执行剩余一次有意义的点击，或停止并报告当前阻塞。'
      }
      state.analyses += 1
      state.analyzed = true
      return undefined
    }

    if (!CLICK_TOOLS.has(name)) return undefined

    const key = businessClickKey(args)
    const attempts = state.clickAttempts.get(key) ?? 0
    if (attempts >= MAX_SAME_BUSINESS_CLICK_ATTEMPTS) {
      return 'DSH Patrol 页面规划器：同一业务点击已经尝试两个方案。禁止继续 patrol_click_target/patrol_click、改名、换 nth-of-type 或包一层 observe 后重试。请停止本轮该步骤并报告最后的 CURRENT 页面证据和错误。'
    }

    if ((name === 'patrol_click' || attempts >= 1) && !state.analyzed) {
      return 'DSH Patrol 页面规划器：不要直接猜 CSS 或重复同一业务点击。先调用 patrol_analyze_step，提供当前 taskChecklist 中这一项业务动作；让理解器基于 CURRENT DOM/iframe/modal/structured table 给出方案后再执行。'
    }

    state.clickAttempts.set(key, attempts + 1)
    if (state.analyzed) state.analyzed = false
    return undefined
  }
}

export function registerPatrolPageUnderstandingTools(
  ctx: Context,
  store: PatrolStore,
  runner: PatrolRunner,
): () => void {
  const analyze = defineTool({
    name: 'patrol_analyze_step',
    description: 'Read-only CURRENT-page business-step planner. Correlates DOM, iframe/modal snapshot evidence and structured table rows with one taskChecklist action, then returns at most three evidence-backed execution plans. It never records a Runbook step and never handles image-code CAPTCHA solving.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      task: { type: 'string', required: true, description: 'One atomic business action from the persisted taskChecklist, e.g. 点击 10.192.3.174 的 RDP 链接.' },
      locatorText: { type: 'string', description: 'Optional visible target text already known from the user request or CURRENT evidence.' },
      tabId: { type: 'integer' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec: ToolRunContext) {
      assertSafePersistentText(args.task, 'page understanding task')
      if (args.locatorText !== undefined) assertSafePersistentText(args.locatorText, 'page understanding locatorText')
      await store.load(args.inspectionId)

      const browserArgs = args.tabId === undefined ? {} : { tabId: args.tabId }
      const [snapshot, page] = await Promise.all([
        runner.dispatch('browser_snapshot', { ...browserArgs, maxElements: 500, includeHidden: false }, exec),
        runner.dispatch('browser_read_page', { ...browserArgs, maxChars: 24000 }, exec),
      ])
      if (!snapshot.ok && !page.ok) {
        throw new Error(`CURRENT page analysis failed: snapshot=${snapshot.error ?? 'unavailable'}; readPage=${page.error ?? 'unavailable'}`)
      }

      const pageText = objectString(page.value, 'text') ?? page.text ?? ''
      const elements = snapshotElements(snapshot.value)
      const plans = analyzePageEvidence(args.task, args.locatorText, pageText, elements)
      const url = objectString(snapshot.value, 'url') ?? objectString(page.value, 'url') ?? ''
      const title = objectString(snapshot.value, 'title') ?? objectString(page.value, 'title') ?? ''
      const modal = objectBoolean(snapshot.value, 'foregroundModal') === true
      return renderUnderstanding(args.task, url, title, modal, plans)
    },
  })

  return ctx.tools.register(analyze)
}

export function analyzePageEvidence(
  task: string,
  locatorText: string | undefined,
  pageText: string,
  elements: readonly SnapshotElement[],
): PageUnderstandingPlan[] {
  const plans: PageUnderstandingPlan[] = []
  const taskTokens = importantTaskTokens(task, locatorText)
  const rowPlan = structuredRowPlan(pageText, taskTokens)
  if (rowPlan !== undefined) plans.push(rowPlan)

  const candidates = rankDomCandidates(elements, taskTokens, locatorText)
  if (candidates.length === 1) {
    const candidate = candidates[0]!
    plans.push({
      kind: 'semantic',
      selector: candidate.selector,
      locatorText: candidate.text || locatorText,
      evidence: `CURRENT DOM 唯一高相关目标 <${candidate.tag || '?'}>${candidate.role ? ` role=${candidate.role}` : ''} text=${JSON.stringify(short(candidate.text, 100))}`,
    })
  } else if (candidates.length > 1) {
    const uniqueSelector = candidates.find(candidate => candidate.selector && candidate.text && normalize(candidate.text) === normalize(locatorText || ''))
    if (uniqueSelector !== undefined && candidates.filter(candidate => normalize(candidate.text) === normalize(uniqueSelector.text)).length === 1) {
      plans.push({
        kind: 'stable-selector',
        selector: uniqueSelector.selector,
        locatorText: uniqueSelector.text,
        evidence: `CURRENT DOM 中语义文本唯一，可使用其稳定 selector：${JSON.stringify(short(uniqueSelector.text, 100))}`,
      })
    } else if (plans.length === 0) {
      plans.push({
        kind: 'no-unique-target',
        evidence: `CURRENT DOM 有 ${candidates.length} 个同等相关候选，不能只按文本盲点；需要行身份、弹窗上下文或更具体的 CURRENT selector。`,
      })
    }
  }

  if (plans.length === 0) {
    plans.push({
      kind: 'no-unique-target',
      evidence: 'CURRENT DOM/structured table 没有找到足够唯一的目标。不要猜内部 URL 或 nth-of-type；当前步骤应停止并报告缺少的页面证据。',
    })
  }
  return dedupePlans(plans).slice(0, 3)
}

function structuredRowPlan(pageText: string, taskTokens: readonly string[]): PageUnderstandingPlan | undefined {
  const rows = pageText.split(/\r?\n/).map(line => line.trim()).filter(line => /^Row\s+\d+:/i.test(line))
  if (rows.length === 0) return undefined
  const identityTokens = taskTokens.filter(token => /\d{1,3}(?:\.\d{1,3}){3}/.test(token) || /\d/.test(token) && token.length >= 4)
  const actionTokens = taskTokens.filter(token => /^(rdp|ssh|vnc|sftp|ftp|https?|打开|登录|详情|访问)$/i.test(token))

  const scored = rows.map(row => {
    const normalized = normalize(row)
    let score = 0
    for (const token of taskTokens) if (normalized.includes(normalize(token))) score += 1
    const identityMatched = identityTokens.length === 0 || identityTokens.every(token => normalized.includes(normalize(token)))
    const selectors = extractClickSelectors(row)
    const actionSelector = selectors.find(entry => actionTokens.some(token => normalize(entry.field).includes(normalize(token))))
    return { row, score, identityMatched, selector: actionSelector?.selector ?? selectors[0]?.selector }
  }).filter(item => item.identityMatched && item.selector !== undefined)

  scored.sort((a, b) => b.score - a.score)
  if (scored.length === 0 || scored[0]!.score <= 0) return undefined
  const bestScore = scored[0]!.score
  const best = scored.filter(item => item.score === bestScore)
  if (best.length !== 1) return undefined
  const chosen = best[0]!
  return {
    kind: 'structured-row',
    selector: chosen.selector,
    evidence: `structured table 唯一匹配用户任务所在行：${short(chosen.row, 240)}`,
  }
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

function rankDomCandidates(
  elements: readonly SnapshotElement[],
  taskTokens: readonly string[],
  locatorText: string | undefined,
): SnapshotElement[] {
  const wanted = normalize(locatorText || '')
  const scored = elements.map(element => {
    const haystack = normalize(`${element.text} ${element.selector} ${element.role} ${element.tag}`)
    let score = 0
    if (wanted && normalize(element.text) === wanted) score += 100
    else if (wanted && normalize(element.text).includes(wanted)) score += 40
    for (const token of taskTokens) if (haystack.includes(normalize(token))) score += 8
    if (element.tag === 'button' || element.tag === 'a' || element.tag === 'input') score += 4
    if (element.role === 'button' || element.role === 'link' || element.role === 'menuitem') score += 3
    if (/\[data-(?:testid|test|cy)=|#[A-Za-z_]|\[name=|\[aria-/i.test(element.selector)) score += 2
    return { element, score }
  }).filter(item => item.score > 0)
  scored.sort((a, b) => b.score - a.score)
  if (scored.length === 0) return []
  const best = scored[0]!.score
  return scored.filter(item => item.score === best).slice(0, 8).map(item => item.element)
}

function importantTaskTokens(task: string, locatorText?: string): string[] {
  const out = new Set<string>()
  if (locatorText?.trim()) out.add(locatorText.trim())
  for (const match of task.matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g)) out.add(match[0])
  for (const match of task.matchAll(/\b(?:RDP|SSH|VNC|SFTP|FTP|HTTP|HTTPS)\b/gi)) out.add(match[0].toUpperCase())
  for (const phrase of ['登录', '确定', '提交', '打开', '访问', '详情', '工作台', '主机运维', '待办待阅工单', '运维']) {
    if (task.includes(phrase)) out.add(phrase)
  }
  const quoted = task.match(/[“"']([^”"']{1,80})[”"']/g) ?? []
  for (const item of quoted) out.add(item.slice(1, -1).trim())
  return [...out].filter(Boolean)
}

function snapshotElements(value: unknown): SnapshotElement[] {
  if (!isRecord(value) || !Array.isArray(value.elements)) return []
  const out: SnapshotElement[] = []
  for (const raw of value.elements) {
    if (!isRecord(raw)) continue
    const selector = cleanString(raw.selector)
    if (!selector) continue
    out.push({
      selector,
      text: cleanString(raw.text),
      role: cleanString(raw.role).toLowerCase(),
      tag: cleanString(raw.tag).toLowerCase(),
    })
  }
  return out
}

function renderUnderstanding(
  task: string,
  url: string,
  title: string,
  foregroundModal: boolean,
  plans: readonly PageUnderstandingPlan[],
): string {
  const lines = [
    'CURRENT PAGE UNDERSTANDING',
    `业务动作：${task}`,
    `页面：${title || '(untitled)'}${url ? ` - ${safeUrl(url)}` : ''}`,
    `上下文：${foregroundModal ? '前景 modal/dialog（优先只操作弹窗内控件）' : '普通页面/iframe/structured table 联合分析'}`,
    '执行方案（按顺序，最多尝试两个）：',
  ]
  plans.forEach((plan, index) => {
    const label = String.fromCharCode(65 + index)
    const selector = plan.selector ? ` selector=${JSON.stringify(plan.selector)}` : ''
    const locator = plan.locatorText ? ` locatorText=${JSON.stringify(plan.locatorText)}` : ''
    lines.push(`${label}. ${plan.kind}${selector}${locator}`)
    lines.push(`   证据：${redactLikelySecrets(plan.evidence)}`)
  })
  lines.push('纪律：先执行 A；失败后只有存在新的 CURRENT 证据才执行 B。两个方案都失败就停止，不再循环 observe/snapshot/read/click。')
  lines.push('验证码例外：图片字符验证码仍走现有专用 OCR solver，本理解器不识别、不刷新、不保存验证码。')
  return lines.join('\n')
}

function businessClickKey(args: Record<string, unknown>): string {
  const descriptor = cleanString(args.stepName) || cleanString(args.locatorText) || 'click'
  return normalize(descriptor).replace(/\d{6,}/g, '#').slice(0, 180) || 'click'
}

function dedupePlans(plans: readonly PageUnderstandingPlan[]): PageUnderstandingPlan[] {
  const seen = new Set<string>()
  const out: PageUnderstandingPlan[] = []
  for (const plan of plans) {
    const key = `${plan.kind}|${plan.selector ?? ''}|${plan.locatorText ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(plan)
  }
  return out
}

function cleanupGuardStates(states: Map<string, PlanningGuardState>, now: number): void {
  for (const [key, state] of states) if (now - state.touchedAt > STATE_TTL_MS) states.delete(key)
}

function safeUrl(value: string): string {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return short(value.split(/[?#]/, 1)[0] ?? value, 240)
  }
}

function objectString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined
  const child = value[key]
  return typeof child === 'string' && child.length > 0 ? child : undefined
}

function objectBoolean(value: unknown, key: string): boolean | undefined {
  if (!isRecord(value)) return undefined
  const child = value[key]
  return typeof child === 'boolean' ? child : undefined
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalize(value: string): string {
  return value.replace(/\s+/g, '').toLocaleLowerCase()
}

function short(value: string, limit: number): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
