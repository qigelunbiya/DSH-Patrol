import { defineTool } from '@deepseek-ai/dsh-tools'

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

export type FlowMutationChoice = 'allow-once' | 'create-new' | 'always-allow'
type FlowMutationPermission = 'allow-once' | 'create-new' | 'always-allow'

const DESTRUCTIVE_FLOW_TOOLS = new Set([
  'patrol_delete',
  'patrol_delete_flow',
  'patrol_delete_step',
  'patrol_remove_steps',
  'patrol_rewrite_flow_path',
])

/**
 * Conversation-level safety gate for destructive changes to an existing flow.
 *
 * The gate deliberately does not inspect or infer user intent itself. Instead,
 * the model must stop and ask the user to choose one of three explicit options.
 * Only patrol_flow_change_choice can unlock a destructive operation.
 *
 * "always-allow" is scoped to one inspection id and the current Harness
 * process. It is intentionally not persisted across restarts, so a stale
 * preference cannot silently destroy a flow days later.
 */
export function createFlowMutationConsentController() {
  const permissions = new Map<string, FlowMutationPermission>()

  const choiceTool = defineTool({
    name: 'patrol_flow_change_choice',
    description: 'Record the user\'s explicit choice for a destructive change to an existing Patrol flow. Call ONLY after the user has answered the confirmation prompt with one of these choices: 确定（允许一次）, 新建一份流程图, 总是确定. Never call this tool proactively or infer the choice from a merely similar patrol request.',
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
      const inspectionId = String(args.inspectionId || '').trim()
      if (!inspectionId) throw new Error('inspectionId is required')
      const choice = String(args.choice || '') as FlowMutationChoice
      if (!['allow-once', 'create-new', 'always-allow'].includes(choice)) {
        throw new Error('invalid flow mutation choice')
      }
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
    },
  })

  const guard = (execution: any): string | undefined => {
    const name = String(execution?.name ?? '')
    if (!DESTRUCTIVE_FLOW_TOOLS.has(name)) return undefined
    const args = isRecord(execution?.arguments) ? execution.arguments : {}
    const inspectionId = typeof args.inspectionId === 'string' ? args.inspectionId.trim() : ''
    if (!inspectionId) return flowMutationPrompt('(unknown flow)')

    const permission = permissions.get(inspectionId)
    if (permission === 'always-allow') return undefined
    if (permission === 'allow-once') {
      permissions.delete(inspectionId)
      return undefined
    }
    if (permission === 'create-new') {
      return [
        'DSH Patrol destructive-flow guard: this destructive action was NOT executed.',
        `The user chose “新建一份流程图” for ${inspectionId}; the existing flow must remain untouched.`,
        'Create a new inspection id and continue there. If the user later changes their mind, ask again and record the new choice with patrol_flow_change_choice.',
      ].join(' ')
    }
    return flowMutationPrompt(inspectionId)
  }

  return { choiceTool, guard }
}

function flowMutationPrompt(inspectionId: string): string {
  return [
    'DSH Patrol destructive-flow guard: this destructive action was NOT executed.',
    `Changing ${inspectionId} would delete, clear, remove, or rewrite existing flow steps.`,
    'Stop and ask the user to choose exactly one option: ① 确定（允许一次） ② 新建一份流程图 ③ 总是确定。',
    'Do not infer consent from a similar patrol request, from the fact that the flow is DRAFT, or from an earlier failed replay.',
    'Only after the user explicitly chooses may you call patrol_flow_change_choice with allow-once, create-new, or always-allow and then continue accordingly.',
  ].join(' ')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
