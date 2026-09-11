import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

export type FlowMutationChoice = 'allow-once' | 'create-new' | 'always-allow'
type FlowMutationPermission = FlowMutationChoice

interface AskUserQuestionOption {
  label: string
  description?: string
}

interface AskUserQuestionItem {
  id: string
  question: string
  detail?: string
  header?: string
  options?: AskUserQuestionOption[]
  multiSelect?: boolean
}

interface AskUserQuestionAnswerItem {
  id: string
  selected: string[]
  custom?: string
}

interface AskUserQuestionAnswer {
  answers: AskUserQuestionAnswerItem[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    userQuestions: {
      ask(request: {
        questions: AskUserQuestionItem[]
        agent?: unknown
        signal?: AbortSignal
      }): Promise<AskUserQuestionAnswer>
    }
  }
}

const DESTRUCTIVE_FLOW_TOOLS = new Set([
  'patrol_delete',
  'patrol_delete_flow',
  'patrol_delete_step',
  'patrol_remove_steps',
  'patrol_rewrite_flow_path',
])

const WHOLE_FLOW_DELETE_TOOLS = new Set([
  'patrol_delete',
  'patrol_delete_flow',
])

const OPTION_ALLOW_ONCE = '确定（允许一次）'
const OPTION_CREATE_NEW = '新建一份流程图'
const OPTION_ALWAYS_ALLOW = '总是确定'

/**
 * Conversation-level safety gate for destructive changes to an existing flow.
 *
 * Fine-grained destructive edits remain blocked until the user makes one
 * explicit choice. Whole-flow deletion is slightly different: patrol_delete
 * already requires confirmed=true at the tool schema/executor layer. Requiring
 * a second confirmation card after the user has explicitly asked to delete or
 * clear the old flow creates a deadlock, so confirmed whole-flow deletion is
 * allowed directly unless the user previously chose create-new.
 *
 * "always-allow" is scoped to one inspection id and the current Harness
 * process. It is intentionally not persisted across restarts, so a stale
 * preference cannot silently destroy a flow days later.
 */
export function createFlowMutationConsentController(ctx?: Context) {
  const permissions = new Map<string, FlowMutationPermission>()

  const applyChoice = (inspectionId: string, choice: FlowMutationChoice): string => {
    permissions.set(inspectionId, choice)
    if (choice === 'allow-once') {
      return [
        `Recorded one-time destructive-change permission for ${inspectionId}.`,
        'Exactly one subsequent destructive flow tool call is allowed; the permission is consumed immediately after that call.',
      ].join(' ')
    }
    if (choice === 'create-new') {
      return [
        `User chose to preserve ${inspectionId} unchanged and create a new flow instead.`,
        'Do NOT delete, clear, remove, or rewrite steps in the existing flow. Create a new inspection id and teach the new request there.',
      ].join(' ')
    }
    return [
      `Recorded always-allow destructive-change permission for ${inspectionId}.`,
      'This applies only to this inspection id for the current Harness process and is not persisted across restarts.',
    ].join(' ')
  }

  const choiceTool = defineTool({
    name: 'patrol_flow_change_choice',
    description: 'Compatibility fallback for recording the user\'s explicit destructive-flow choice after the user already answered in plain text. Prefer patrol_request_flow_change_choice so the Harness GUI renders the three-option card. Never infer the choice from a similar patrol request, DRAFT state, or replay failure.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      choice: {
        type: 'string',
        required: true,
        enum: ['allow-once', 'create-new', 'always-allow'],
        description: 'allow-once=确定（允许一次）; create-new=新建一份流程图并保留旧流程; always-allow=总是确定（仅当前流程、当前 Harness 进程）.',
      },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const inspectionId = requireInspectionId(args.inspectionId)
      const choice = requireChoice(args.choice)
      return applyChoice(inspectionId, choice)
    },
  })

  const requestChoiceTool = defineTool({
    name: 'patrol_request_flow_change_choice',
    description: 'Show the native Harness three-option confirmation card before fine-grained deletion, clearing, removal, or rewriting of steps in an existing Patrol flow. Do not use this extra card when the current user message already explicitly asks to delete/clear the whole old flow; use patrol_delete with confirmed=true in that case. The options are exactly: 确定（允许一次）, 新建一份流程图, 总是确定.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      reason: { type: 'string', description: 'Short user-language explanation of why the existing flow would need destructive cleanup/rewrite. Do not include secrets.' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const inspectionId = requireInspectionId(args.inspectionId)
      const service = (ctx as { userQuestions?: Context['userQuestions'] } | undefined)?.userQuestions
      if (service === undefined) {
        throw new Error([
          'patrol_request_flow_change_choice unavailable: no user-questions service/provider is active.',
          `Ask the user in plain text to choose exactly one: ① ${OPTION_ALLOW_ONCE} ② ${OPTION_CREATE_NEW} ③ ${OPTION_ALWAYS_ALLOW}.`,
          'After the user explicitly answers, record that answer with patrol_flow_change_choice. Do not perform the destructive action before then.',
        ].join(' '))
      }

      let answer: AskUserQuestionAnswer
      try {
        answer = await service.ask({
          questions: [{
            id: `patrol-flow-change-${inspectionId}`,
            header: '流程修改确认',
            question: '检测到需要删除、清空或重写已有流程步骤。你希望怎么处理？',
            detail: [
              `当前流程：${inspectionId}`,
              typeof args.reason === 'string' && args.reason.trim() ? `原因：${args.reason.trim()}` : '',
              '为避免误删已经反复教学得到的流程，未选择前不会修改原流程。',
            ].filter(Boolean).join('\n'),
            options: [
              { label: OPTION_ALLOW_ONCE, description: '只允许接下来一次删除/清理/重写操作，执行后自动恢复保护。' },
              { label: OPTION_CREATE_NEW, description: '完整保留当前流程，创建一个新的流程图处理本次需求。' },
              { label: OPTION_ALWAYS_ALLOW, description: '本次 Harness 运行期间，对当前流程后续破坏性修改不再重复询问；重启后失效。' },
            ],
            multiSelect: false,
          }],
          ...(exec?.agent === undefined ? {} : { agent: exec.agent }),
          ...(exec?.signal === undefined ? {} : { signal: exec.signal }),
        })
      } catch (error) {
        const code = (error as { code?: string }).code
        if (code === 'NO_PROVIDER') {
          throw new Error([
            'patrol_request_flow_change_choice unavailable: the current client has no user-questions UI provider.',
            `Ask in plain text: ① ${OPTION_ALLOW_ONCE} ② ${OPTION_CREATE_NEW} ③ ${OPTION_ALWAYS_ALLOW}.`,
            'Then call patrol_flow_change_choice only after the user explicitly replies.',
          ].join(' '))
        }
        throw error
      }

      const item = answer.answers.find(entry => entry.id === `patrol-flow-change-${inspectionId}`)
      const selected = item?.selected?.[0]?.trim() || item?.custom?.trim() || ''
      const choice = choiceFromLabel(selected)
      if (choice === undefined) {
        throw new Error('No valid destructive-flow choice was selected; the existing flow remains protected and unchanged.')
      }
      return `${applyChoice(inspectionId, choice)} Selected option: ${selected}.`
    },
  })

  const guard = (execution: any): string | undefined => {
    const name = String(execution?.name ?? '')
    if (!DESTRUCTIVE_FLOW_TOOLS.has(name)) return undefined
    const args = isRecord(execution?.arguments) ? execution.arguments : {}
    const inspectionId = typeof args.inspectionId === 'string' ? args.inspectionId.trim() : ''
    if (!inspectionId) return flowMutationPrompt('(unknown flow)')

    const permission = permissions.get(inspectionId)
    if (permission === 'create-new') {
      return [
        'DSH Patrol destructive-flow guard: this destructive action was NOT executed.',
        `The user chose “${OPTION_CREATE_NEW}” for ${inspectionId}; the existing flow must remain untouched.`,
        'Create a new inspection id and continue there. If the user later changes their mind, ask again through patrol_request_flow_change_choice.',
      ].join(' ')
    }
    if (permission === 'always-allow') return undefined
    if (permission === 'allow-once') {
      permissions.delete(inspectionId)
      return undefined
    }

    // Whole-flow deletion already has a mandatory confirmed=true gate inside
    // patrol_delete. When the user explicitly says “delete/clear the old flow”,
    // the Agent should pass confirmed=true and must not be forced through a
    // second confirmation loop. Keep partial edits protected by the card.
    if (WHOLE_FLOW_DELETE_TOOLS.has(name) && args.confirmed === true) return undefined

    return flowMutationPrompt(inspectionId)
  }

  return { choiceTool, requestChoiceTool, guard }
}

function requireInspectionId(value: unknown): string {
  const inspectionId = String(value || '').trim()
  if (!inspectionId) throw new Error('inspectionId is required')
  return inspectionId
}

function requireChoice(value: unknown): FlowMutationChoice {
  const choice = String(value || '') as FlowMutationChoice
  if (!['allow-once', 'create-new', 'always-allow'].includes(choice)) throw new Error('invalid flow mutation choice')
  return choice
}

function choiceFromLabel(value: string): FlowMutationChoice | undefined {
  const normalized = value.replace(/\s+/g, '').trim()
  if (normalized === OPTION_ALLOW_ONCE.replace(/\s+/g, '') || normalized === 'allow-once') return 'allow-once'
  if (normalized === OPTION_CREATE_NEW.replace(/\s+/g, '') || normalized === 'create-new') return 'create-new'
  if (normalized === OPTION_ALWAYS_ALLOW.replace(/\s+/g, '') || normalized === 'always-allow') return 'always-allow'
  return undefined
}

function flowMutationPrompt(inspectionId: string): string {
  return [
    'DSH Patrol destructive-flow guard: this destructive action was NOT executed.',
    `Changing ${inspectionId} would delete, clear, remove, or rewrite existing flow steps.`,
    `For partial step cleanup/rewrite, call patrol_request_flow_change_choice to show the native three-option prompt: ① ${OPTION_ALLOW_ONCE} ② ${OPTION_CREATE_NEW} ③ ${OPTION_ALWAYS_ALLOW}.`,
    'If the CURRENT user message explicitly asks to delete/clear the whole old flow, call patrol_delete with confirmed=true instead of asking the same question again.',
    'Do not infer consent from a merely similar patrol request, from the fact that the flow is DRAFT, or from an earlier failed replay.',
    'If the client has no question-card provider and a partial destructive edit really is needed, ask those same three options in plain text and use patrol_flow_change_choice only after the user explicitly answers.',
  ].join(' ')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
