import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

const OBSERVATION_REQUIRED = new Set([
  'patrol_navigate',
  'patrol_browser_step',
  'patrol_type_text',
  'patrol_type_transient',
  'patrol_type_credential',
  'patrol_click',
  'patrol_press',
  'patrol_detect_auth_challenge',
  'patrol_reteach_browser_step',
  'patrol_reteach_text',
  'patrol_reteach_transient',
  'patrol_reteach_credential',
  'patrol_validate',
  'patrol_resume_validation',
  'patrol_run',
  'patrol_resume',
])

const PAGE_STATE_INVALIDATING = new Set([
  'patrol_navigate',
  'patrol_browser_step',
  'patrol_click',
  'patrol_press',
  'patrol_reteach_browser_step',
  'patrol_validate',
  'patrol_resume_validation',
  'patrol_run',
  'patrol_resume',
])

const OBSERVATION_TTL_MS = 90_000

export type PatrolBootstrapObservationKind = 'unobservable-tab' | 'no-tab'

interface ObservationState {
  rootCallId: string
  observedAt: number
  mode: 'visual' | 'bootstrap'
  bootstrapKind?: PatrolBootstrapObservationKind
}

export const PATROL_OBSERVATION_PROMPT = `Patrol current-state visual gate（当前状态优先级高于旧 Runbook 和历史对话）：
- 每个新的助手轮次里，在任何会改变浏览器状态的 Patrol 操作之前，必须先调用 patrol_observe。patrol_observe 是只读工具，不会向 Runbook 追加步骤。
- patrol_observe 的硬要求是“先成功截取当前活动页”。如果当前 Harness route 支持图像输入，它会进一步把截图作为 image block 交给模型；如果 read_image 不可用或当前模型不支持图像，它会自动退化为“刚刚截下来的截图 OCR + 当前 DOM snapshot”，并仍然视为成功观察。图像附件失败绝不能阻塞巡检。
- 当 patrol_observe 返回 screenshot-ocr-snapshot fallback 时，不要为了获得 image block 循环调用 patrol_observe / patrol_screenshot / patrol_snapshot / patrol_read_page。直接依据当前 fallback 证据继续；只有真正需要验证码内容时调用专用 patrol_detect_auth_challenge。
- patrol_observe 会在检测到 CAPTCHA/image-code 输入框时主动隐藏整页 OCR 文本，避免之前填入输入框的旧验证码重新污染模型判断。验证码答案只能来自当前验证码图/专用 detector；历史消息、旧 OCR、旧截图和失败提交前的验证码都不可复用。
- 唯一启动例外：managed browser 刚启动时可能只有空白/新标签页，Chromium 禁止扩展截图这类内部页面。patrol_observe 会先读取只读标签页元数据并明确返回 bootstrap 状态；此时只允许执行一次 patrol_navigate 到用户指定的真实 URL，导航后必须立刻再次 patrol_observe。这个例外绝不能用于 reload/back/forward、点击、输入、run、validate 或 resume。
- 不得把 patrol_navigate/reload、patrol_validate、patrol_run、patrol_resume 或 patrol_resume_validation 当成“继续一下/刷新状态”的默认动作。先 observe，再根据当前页面决定是否真的需要重放或导航。
- 用户刚刚手工完成 OTP、设备确认、扫码、输入一次性口令或其他页面交互后，下一轮首先 patrol_observe。若当前页面已经进入系统，就直接从当前位置继续，不得为了“恢复巡检”重放登录流程。
- teaching 阶段的 DRAFT Runbook 里，patrol_add_checkpoint 只是记录未来需要人工处理的步骤，并不等于当前存在可 resume 的运行。用户在当前浏览器现场完成 OTP 后，不要调用 patrol_resume / patrol_resume_validation / patrol_validate；先 observe 当前页面，然后继续教学后续步骤。
- 只有 patrol_run 明确返回 waiting checkpoint 后才用 patrol_resume；只有 patrol_validate 明确返回 waiting checkpoint 后才用 patrol_resume_validation。
- 页面改变型动作会消耗当前观察证据；发生导航、点击、按键、完整 run/validate/resume 后，下一次再做页面改变型动作前必须重新 observe。`

export interface PatrolObservationGate {
  markObserved(inspectionId: string, rootCallId: ToolRunContext['rootCallId']): void
  markBootstrap(inspectionId: string, rootCallId: ToolRunContext['rootCallId'], kind: PatrolBootstrapObservationKind): void
  guard(execution: any): string | undefined
}

export function createPatrolObservationGate(): PatrolObservationGate {
  const states = new Map<string, ObservationState>()

  return {
    markObserved(inspectionId, rootCallId) {
      const id = String(inspectionId || '').trim()
      if (!id) return
      states.set(id, {
        rootCallId: callKey(rootCallId),
        observedAt: Date.now(),
        mode: 'visual',
      })
    },

    markBootstrap(inspectionId, rootCallId, kind) {
      const id = String(inspectionId || '').trim()
      if (!id) return
      states.set(id, {
        rootCallId: callKey(rootCallId),
        observedAt: Date.now(),
        mode: 'bootstrap',
        bootstrapKind: kind,
      })
    },

    guard(execution) {
      const name = String(execution?.name ?? '')
      if (!OBSERVATION_REQUIRED.has(name)) return undefined
      const args = isRecord(execution?.arguments) ? execution.arguments : {}
      const inspectionId = typeof args.inspectionId === 'string' ? args.inspectionId.trim() : ''
      if (!inspectionId) return undefined

      const state = states.get(inspectionId)
      const sameTurn = state !== undefined && belongsToCurrentHarnessTurn(state, execution)
      const fresh = sameTurn && Date.now() - state.observedAt <= OBSERVATION_TTL_MS

      if (!fresh) {
        return [
          'DSH Patrol current-state gate：本轮在执行会改变浏览器状态的操作前，必须先调用 patrol_observe。',
          'patrol_observe 会先截取当前活动页；图像附件可用时直接附图，不可用时自动退化为当前截图 OCR + DOM snapshot，fallback 也算成功观察。',
          '不要用 patrol_screenshot/snapshot/read_page 循环替代 observe；如果用户刚完成 OTP、设备确认或其他人工操作，也必须先观察当前状态。',
        ].join(' ')
      }

      if (state.mode === 'bootstrap') {
        if (name !== 'patrol_navigate') return bootstrapGateError(state.bootstrapKind)
        const url = typeof args.url === 'string' ? args.url.trim() : ''
        if (!url) return bootstrapGateError(state.bootstrapKind)
        if (state.bootstrapKind === 'no-tab' && args.newTab !== true) {
          return 'DSH Patrol bootstrap gate：当前浏览器没有任何标签页。只允许 patrol_navigate 指定真实 URL 且 newTab=true 创建第一个页面；导航后必须立刻 patrol_observe。'
        }
        states.delete(inspectionId)
        return undefined
      }

      if (PAGE_STATE_INVALIDATING.has(name)) states.delete(inspectionId)
      return undefined
    },
  }
}

export function belongsToCurrentHarnessTurn(state: Pick<ObservationState, 'rootCallId' | 'observedAt'>, execution: any): boolean {
  const events = execution?.agent?.session?.events
  if (Array.isArray(events)) {
    const currentTurn = latestTurnNumber(events)
    const observedTurn = turnForRootCall(events, state.rootCallId)
    if (currentTurn !== undefined && observedTurn !== undefined) return currentTurn === observedTurn

    const currentTurnStartedAt = latestTurnStartedAt(events)
    if (currentTurnStartedAt !== undefined) return currentTurnStartedAt <= state.observedAt
  }

  return state.rootCallId === callKey(execution?.rootCallId)
}

function latestTurnNumber(events: readonly unknown[]): number | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (!isRecord(event) || event.type !== 'turn/start' || !isRecord(event.data)) continue
    const turn = event.data.turn
    if (typeof turn === 'number') return turn
  }
  return undefined
}

function latestTurnStartedAt(events: readonly unknown[]): number | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (!isRecord(event) || event.type !== 'turn/start') continue
    const time = event.time
    if (typeof time === 'number') return time
  }
  return undefined
}

function turnForRootCall(events: readonly unknown[], rootCallId: string): number | undefined {
  if (rootCallId === '(no-root-call)') return undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (!isRecord(event) || event.type !== 'tool/call' || !isRecord(event.data)) continue
    if (callKey(event.data.callId) !== rootCallId) continue
    const turn = event.data.turn
    if (typeof turn === 'number') return turn
  }
  return undefined
}

function bootstrapGateError(kind: PatrolBootstrapObservationKind | undefined): string {
  const stateText = kind === 'no-tab' ? '没有可观察标签页' : '当前只有 Chromium 空白/新标签页，无法截取页面像素'
  return `DSH Patrol bootstrap gate：${stateText}。patrol_observe 已完成启动状态检查，但此状态只授权一次 patrol_navigate 到用户指定的真实 URL；导航后必须立刻再次 patrol_observe，其他浏览器操作仍被禁止。`
}

function callKey(value: unknown): string {
  return value === undefined || value === null ? '(no-root-call)' : String(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
