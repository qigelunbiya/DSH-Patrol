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
const CLICK_TOOLS = new Set(['patrol_click', 'patrol_click_target'])
const PHASE_PROGRESS_TOOLS = new Set([
  'patrol_navigate', 'patrol_type', 'patrol_type_text', 'patrol_type_transient',
  'patrol_type_credential', 'patrol_type_totp_profile', 'patrol_select', 'patrol_press',
  'patrol_resume', 'patrol_resume_validation', 'patrol_run', 'patrol_run_flow',
])

interface PlanningGuardState {
  touchedAt: number
  analyses: number
  analyzed: boolean
  lastAnalysisTask: string
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
  selector?: string | undefined
  locatorText?: string | undefined
  evidence: string
}

export const PATROL_PAGE_UNDERSTANDING_PROMPT = `DSH Patrol 页面理解与执行规划（NORMAL/TEST MODE 都必须遵守）：
- taskChecklist 只描述业务动作；真正执行页面动作前，要根据 CURRENT DOM/iframe/modal/structured table 判断该业务动作对应的真实前端结构，不要把用户文字直接翻译成 nth-of-type 后盲点。
- 唯一且明显的文本目标可直接 patrol_click_target。第一次定位失败、出现 ambiguous、同名控件有多个、目标位于表格行/弹窗/iframe 时，必须先 patrol_analyze_step，再按其 CURRENT 证据给出的 A/B 方案执行；不要先堆 snapshot/read_page/wait 试探。
- patrol_analyze_step 永远不写 Runbook。它优先把“行身份 + 行内动作”绑定，例如“10.192.3.174 + RDP”，避免只按 [RDP] 命中多行。不要把分析器给出的 selector 再扩写成更长的 nth-of-type。
- 同一业务点击最多两个外部方案：第一次可以直接语义点击；失败后必须重新理解页面，第二次必须基于新的 CURRENT 证据。第二次仍失败就停止并报告，不得在 click_target/click/observe/snapshot 之间循环换皮重试。
- 不要为每个内部工具调用向用户重复“我再观察一下/我再试一下/让我换个选择器”。只有需要用户输入/确认、遇到不可恢复阻塞、或任务最终完成时才发自然语言说明。
- 教学轨迹不等于 Runbook。诊断 snapshot/read、失败点击、重复输入、临时等待都不是最终流程。任务完成后必须 patrol_finalize_flow，只保留真正完成 taskChecklist 的已验证业务路径，再确认流程。已有非空 DRAFT 缺 checklist 时使用非破坏性 backfill，不能因此清空/重建。
- targetUrl/browser_navigate 必须是纯 http/https URL。若对话渲染成 Markdown 链接 [url](url)，还原 href 后再调用工具，禁止把 Markdown 链接字符串写进 Flow JSON。
- 这套理解器绝对不能替换图片字符验证码链路。image-code 继续使用现有 patrol_solve_current_image_code / ddddocr + Windows OCR 及 CURRENT 裁图后备方案；不得重新识别、重复刷新或降低验证码置信度门槛。OTP/TOTP 继续走现有专用工具。`

/** Always-on even in TEST MODE: bound model-facing retry strategies. */
export function createPatrolPlanningGuard() {
  const states = new Map<string, PlanningGuardState>()
  return (execution: any): string | undefined => {
    const name = String(execution?.name ?? '')
    if (!name.startsWith('patrol_')) return undefined
    const args = isRecord(execution?.arguments) ? execution.arguments : {}
    const inspectionId = cleanString(args.inspectionId)
    if (!inspectionId) return undefined

    const urlIssue = malformedPatrolUrl(name, args)
    if (urlIssue !== undefined) return urlIssue

    const now = Date.now()
    for (const [key, value] of states) if (now - value.touchedAt > STATE_TTL_MS) states.delete(key)
    let state = states.get(inspectionId)
    if (state === undefined) {
      state = { touchedAt: now, analyses: 0, analyzed: false, lastAnalysisTask: '', clickAttempts: new Map() }
      states.set(inspectionId, state)
    }
    state.touchedAt = now

    if (PHASE_PROGRESS_TOOLS.has(name)) {
      states.delete(inspectionId)
      return undefined
    }
    if (name === 'patrol_analyze_step') {
      const taskKey = normalize(cleanString(args.task) || 'analysis')
      if (taskKey !== state.lastAnalysisTask) {
        state.analyses = 0
        state.analyzed = false
        state.lastAnalysisTask = taskKey
      }
      if (state.analyses >= 2) {
        return 'DSH Patrol 页面规划器：同一业务动作的当前页面已经分析两次且没有新的业务进展。不要继续 analyze/observe/snapshot 循环；执行剩余方案或停止并报告阻塞。'
      }
      state.analyses += 1
      state.analyzed = true
      return undefined
    }
    if (!CLICK_TOOLS.has(name)) return undefined

    const key = businessClickKey(args)
    const attempts = state.clickAttempts.get(key) ?? 0
    if (attempts >= 2) {
      return 'DSH Patrol 页面规划器：同一业务点击已经尝试两个方案。禁止继续 click_target/click、改名、换 nth-of-type 或包一层 observe 后重试；停止并报告最后的 CURRENT 证据和错误。'
    }
    if ((name === 'patrol_click' || attempts >= 1) && !state.analyzed) {
      return 'DSH Patrol 页面规划器：不要直接猜 CSS 或重复同一业务点击。先调用 patrol_analyze_step，提供 taskChecklist 中当前业务动作，再基于 CURRENT DOM/iframe/modal/structured table 方案执行。'
    }
    state.clickAttempts.set(key, attempts + 1)
    if (state.analyzed) state.analyzed = false
    return undefined
  }
}

export function registerPatrolPageUnderstandingTools(ctx: Context, store: PatrolStore, runner: PatrolRunner): () => void {
  const analyze = defineTool({
    name: 'patrol_analyze_step',
    description: 'Read-only CURRENT-page planner. Correlates DOM, iframe/modal evidence and structured table rows with one taskChecklist action and returns at most three evidence-backed plans. Never records a Runbook step and never solves image-code CAPTCHA.',
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
      const [snapshot, page] = await Promise.all([
        runner.dispatch('browser_snapshot', { ...base, maxElements: 500, includeHidden: false }, exec),
        runner.dispatch('browser_read_page', { ...base, maxChars: 24000 }, exec),
      ])
      if (!snapshot.ok && !page.ok) {
        throw new Error(`CURRENT page analysis failed: snapshot=${snapshot.error ?? 'unavailable'}; readPage=${page.error ?? 'unavailable'}`)
      }
      const plans = analyzePageEvidence(
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
  const scored = elements.map(element => {
    const haystack = normalize(`${element.text} ${element.selector} ${element.role} ${element.tag}`)
    let score = wanted && normalize(element.text) === wanted ? 100 : wanted && normalize(element.text).includes(wanted) ? 40 : 0
    score += tokens.filter(token => haystack.includes(normalize(token))).length * 8
    if (['button', 'a', 'input'].includes(element.tag)) score += 4
    if (['button', 'link', 'menuitem'].includes(element.role)) score += 3
    if (/\[data-(?:testid|test|cy)=|#[A-Za-z_]|\[name=|\[aria-/i.test(element.selector)) score += 2
    return { element, score }
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score)
  if (!scored[0]) return []
  return scored.filter(item => item.score === scored[0]!.score).slice(0, 8).map(item => item.element)
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
    '执行方案（按顺序，最多尝试两个）：',
  ]
  plans.forEach((plan, index) => {
    lines.push(`${String.fromCharCode(65 + index)}. ${plan.kind}${plan.selector ? ` selector=${JSON.stringify(plan.selector)}` : ''}${plan.locatorText ? ` locatorText=${JSON.stringify(plan.locatorText)}` : ''}`)
    lines.push(`   证据：${redactLikelySecrets(plan.evidence)}`)
  })
  lines.push('纪律：先执行 A；失败后只有存在新的 CURRENT 证据才执行 B。两个方案都失败就停止，不再循环 observe/snapshot/read/click。')
  lines.push('验证码例外：图片字符验证码仍走现有专用 OCR solver，本理解器不识别、不刷新、不保存验证码。')
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

function businessClickKey(args: Record<string, unknown>): string {
  return (normalize(cleanString(args.stepName) || cleanString(args.locatorText) || 'click').replace(/\d{6,}/g, '#').slice(0, 180) || 'click')
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
function cleanString(value: unknown): string { return typeof value === 'string' ? value.trim() : '' }
function normalize(value: string): string { return value.replace(/\s+/g, '').toLocaleLowerCase() }
function short(value: string, limit: number): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}
function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
