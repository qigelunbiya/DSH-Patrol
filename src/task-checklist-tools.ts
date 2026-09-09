import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { assertSafePersistentText } from './security.js'
import type { PatrolStore } from './store.js'

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

/**
 * Persist the user's business contract before any browser teaching action.
 * Keeping this separate from create_draft is backward compatible with older
 * clients while allowing the runtime guard to require the checklist for newly
 * created conversational flows.
 */
export function registerPatrolTaskChecklistTools(ctx: Context, store: PatrolStore): () => void {
  const setChecklist = defineTool({
    name: 'patrol_set_task_checklist',
    description: 'Immediately after patrol_create_draft, persist the ordered business steps derived from the user request before navigation/click/type teaching begins. One item per user-required business action; exclude diagnostic observations and recovery guesses.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      items: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: 'Ordered user-required business actions, e.g. 访问目标URL, 点击Logo, 输入用户名, 输入密码, 输入验证码, 点击登录, 点击我的工作台, 点击待办菜单, 读取工单, 截图, 打开一张工单, 截图。',
      },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const definition = await store.load(args.inspectionId)
      if (definition.status !== 'draft') throw new Error(`inspection ${definition.id} is ${definition.status}; task checklist can only be set on a DRAFT`)
      if (definition.steps.length > 0) {
        throw new Error('task checklist must be fixed before teaching actions are recorded; clear/recreate the DRAFT instead of retroactively rewriting the business contract')
      }
      if (!Array.isArray(args.items) || args.items.length === 0) throw new Error('task checklist must contain at least one business action')
      if (args.items.length > 100) throw new Error('task checklist is too large; keep it to <= 100 concrete business actions')
      const items = args.items.map((raw, index) => {
        const item = typeof raw === 'string' ? raw.trim() : ''
        if (!item) throw new Error(`task checklist item ${index + 1} is empty`)
        assertSafePersistentText(item, `taskChecklist[${index}]`)
        return item
      })
      definition.metadata.taskChecklist = items
      definition.metadata.updatedAt = new Date().toISOString()
      delete definition.metadata.flowHealth
      await store.save(definition)
      return [
        `Saved ${items.length} ordered business task(s) for ${definition.id}.`,
        ...items.map((item, index) => `${index + 1}. ${item}`),
        'Now teach strictly in this order. Diagnostic observations may help execution but are not checklist completion steps.',
      ].join('\n')
    },
  })

  const showChecklist = defineTool({
    name: 'patrol_task_checklist',
    description: 'Show the persisted ordered business checklist for a DRAFT/READY inspection.',
    parameters: { inspectionId: { type: 'string', required: true } },
    output: TEXT_OUTPUT,
    async execute(args) {
      const definition = await store.load(args.inspectionId)
      const items = definition.metadata.taskChecklist ?? []
      if (items.length === 0) return `Inspection ${definition.id} has no persisted task checklist.`
      return items.map((item, index) => `${index + 1}. ${item}`).join('\n')
    },
  })

  const disposers = [ctx.tools.register(setChecklist), ctx.tools.register(showChecklist)]
  return () => { for (const dispose of disposers) dispose() }
}
