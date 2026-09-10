import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { assertSafePersistentText } from './security.js'
import type { PatrolStore } from './store.js'

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

/**
 * Persist the user's business contract before browser teaching actions. Legacy
 * or reused non-empty DRAFTs may predate this invariant; when they have no
 * checklist yet, backfilling the contract is safe because it preserves every
 * existing step and does not rewrite the route. A conflicting existing
 * checklist is still immutable without an explicit destructive edit flow.
 */
export function registerPatrolTaskChecklistTools(ctx: Context, store: PatrolStore): () => void {
  const setChecklist = defineTool({
    name: 'patrol_set_task_checklist',
    description: 'Persist the ordered business steps derived from the user request. Prefer immediately after patrol_create_draft. For a legacy/reused non-empty DRAFT that has no checklist yet, this safely backfills the checklist without deleting or rewriting existing steps. One item per user-required business action; exclude diagnostic observations and recovery guesses.',
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
      if (!Array.isArray(args.items) || args.items.length === 0) throw new Error('task checklist must contain at least one business action')
      if (args.items.length > 100) throw new Error('task checklist is too large; keep it to <= 100 concrete business actions')
      const items = args.items.map((raw, index) => {
        const item = typeof raw === 'string' ? raw.trim() : ''
        if (!item) throw new Error(`task checklist item ${index + 1} is empty`)
        assertSafePersistentText(item, `taskChecklist[${index}]`)
        return item
      })

      const existing = definition.metadata.taskChecklist ?? []
      if (existing.length > 0) {
        if (sameChecklist(existing, items)) {
          return [
            `Inspection ${definition.id} already has the same ${existing.length}-item business checklist; kept it unchanged.`,
            'Continue from the CURRENT page/failed step. Do not clear or recreate this flow merely to satisfy the checklist invariant.',
          ].join('\n')
        }
        throw new Error([
          `inspection ${definition.id} already has a different persisted task checklist`,
          'DSH Patrol will not silently rewrite the existing business contract.',
          'If the user truly changed the task, use the explicit flow-change/new-flow path instead of replacing the checklist in place.',
        ].join(' '))
      }

      const backfilled = definition.steps.length > 0
      definition.metadata.taskChecklist = items
      definition.metadata.updatedAt = new Date().toISOString()
      delete definition.metadata.flowHealth
      await store.save(definition)
      return [
        backfilled
          ? `Backfilled ${items.length} ordered business task(s) for existing DRAFT ${definition.id}; preserved all ${definition.steps.length} existing step(s).`
          : `Saved ${items.length} ordered business task(s) for ${definition.id}.`,
        ...items.map((item, index) => `${index + 1}. ${item}`),
        backfilled
          ? 'This was a non-destructive legacy/reuse repair. Continue with CURRENT-page understanding and finalize only the verified successful path; do not clear/recreate the DRAFT.'
          : 'Now teach strictly in this order. Diagnostic observations may help execution but are not checklist completion steps.',
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

function sameChecklist(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  return left.every((item, index) => normalizeChecklistItem(item) === normalizeChecklistItem(right[index] ?? ''))
}

function normalizeChecklistItem(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}
