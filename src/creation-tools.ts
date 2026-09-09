import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { assertSafeForStorage, assertSafePersistentText } from './security.js'
import { PatrolStore } from './store.js'
import { INSPECTION_ARTIFACTS, type AuthMode, type InspectionArtifact, type InspectionDefinition, type RunReport } from './types.js'
import { assertInspectionId, normalizeInspectionId } from './validation.js'

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

type InteractivePatrolStore = PatrolStore & {
  beginTeachingRun?: (inspectionId: string, workspaceRoot?: string) => Promise<RunReport>
}

export function registerPatrolCreationTools(ctx: Context, store: PatrolStore): () => void {
  const createInspection = defineTool({
    name: 'patrol_create_inspection',
    description: 'Create or reuse a Patrol DRAFT using only non-secret metadata. Triggering this tool for a DRAFT also starts an in-progress patrol history record immediately, before the browser workflow is finished.',
    parameters: {
      inspectionId: { type: 'string', required: true, description: 'Stable short id, e.g. idc-project-task-weekly.' },
      name: { type: 'string', required: true },
      description: { type: 'string', required: true },
      targetUrl: { type: 'string', required: true },
      expectedResult: { type: 'string', required: true },
      authMode: { type: 'string', required: true, enum: ['none', 'existing-session', 'manual-checkpoint', 'secret-ref'] },
      artifacts: { type: 'array', items: { type: 'string', enum: [...INSPECTION_ARTIFACTS] } },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const inspectionId = normalizeInspectionId(args.inspectionId)
      assertInspectionId(inspectionId)
      const workspaceRoot = exec?.agent?.session.header.cwd
      if (await store.exists(inspectionId)) {
        const existing = await store.load(inspectionId)
        if (existing.status === 'draft' && existing.steps.length === 0) {
          await beginInteractivePatrol(store, existing.id, workspaceRoot ?? existing.metadata.workspaceRoot)
          return `Inspection ${existing.id} already exists as an empty DRAFT. Continue teaching it with patrol_* action tools; this interactive patrol has already been added to patrol history as an in-progress run.`
        }
        return `Inspection ${existing.id} already exists with status=${existing.status} and ${existing.steps.length} step(s). Reuse it without appending: call patrol_run_flow to execute the existing flow, or call patrol_begin_edit only when the user explicitly wants to change a specific step. Do not continue recording browser actions at the end of this Runbook.`
      }

      assertSafePersistentText(args.name, 'inspection.name')
      assertSafePersistentText(args.description, 'inspection.description')
      assertSafePersistentText(args.expectedResult, 'inspection.expectedResult')
      assertSafeForStorage({ url: args.targetUrl })

      const now = new Date().toISOString()
      const definition: InspectionDefinition = {
        schemaVersion: '0.2',
        id: inspectionId,
        name: args.name,
        description: args.description,
        status: 'draft',
        target: { type: 'browser', url: args.targetUrl },
        expectedResult: args.expectedResult,
        artifacts: (args.artifacts ?? ['markdown-report', 'json-report']) as InspectionArtifact[],
        auth: { mode: args.authMode as AuthMode },
        schedule: null,
        steps: [],
        metadata: {
          createdAt: now,
          updatedAt: now,
          ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
        },
      }
      await store.create(definition)
      await beginInteractivePatrol(store, definition.id, workspaceRoot)
      return `Created DRAFT ${definition.id} without persisting any auth notes or plaintext secret. An in-progress patrol history record was created immediately. User-visible run outputs will default to the current Harness workspace${workspaceRoot === undefined ? '' : `: ${workspaceRoot}`}. Next run patrol_doctor, then teach with the flat patrol_* action tools.`
    },
  })

  const dispose = ctx.tools.register(createInspection)
  return () => dispose()
}

async function beginInteractivePatrol(store: PatrolStore, inspectionId: string, workspaceRoot?: string): Promise<void> {
  const lifecycle = store as InteractivePatrolStore
  if (typeof lifecycle.beginTeachingRun !== 'function') return
  await lifecycle.beginTeachingRun(inspectionId, workspaceRoot)
}
