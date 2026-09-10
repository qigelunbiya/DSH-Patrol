import { describe, expect, it } from 'vitest'
import { createFlowMutationConsentController } from '../src/flow-mutation-consent.js'

describe('destructive flow mutation consent', () => {
  it('blocks destructive cleanup until the user choice tool grants permission', async () => {
    const controller = createFlowMutationConsentController()
    const blocked = controller.guard({
      name: 'patrol_remove_steps',
      arguments: { inspectionId: 'important-flow', stepIds: ['step-001', 'step-002'] },
    })
    expect(blocked).toMatch(/destructive-flow guard/i)
    expect(blocked).toMatch(/确定（允许一次）/)
    expect(blocked).toMatch(/新建一份流程图/)
    expect(blocked).toMatch(/总是确定/)

    await controller.choiceTool.execute({ inspectionId: 'important-flow', choice: 'allow-once' } as any, {} as any)
    expect(controller.guard({
      name: 'patrol_remove_steps',
      arguments: { inspectionId: 'important-flow', stepIds: ['step-001'] },
    })).toBeUndefined()

    // One-time permission is consumed by exactly one destructive call.
    expect(controller.guard({
      name: 'patrol_remove_steps',
      arguments: { inspectionId: 'important-flow', stepIds: ['step-002'] },
    })).toMatch(/destructive-flow guard/i)
  })

  it('preserves the old flow when the user chooses create-new', async () => {
    const controller = createFlowMutationConsentController()
    await controller.choiceTool.execute({ inspectionId: 'important-flow', choice: 'create-new' } as any, {} as any)

    const blocked = controller.guard({
      name: 'patrol_delete',
      arguments: { inspectionId: 'important-flow', confirmed: true },
    })
    expect(blocked).toMatch(/新建一份流程图/)
    expect(blocked).toMatch(/existing flow must remain untouched/i)
  })

  it('allows repeated destructive changes only after explicit always-allow choice', async () => {
    const controller = createFlowMutationConsentController()
    await controller.choiceTool.execute({ inspectionId: 'important-flow', choice: 'always-allow' } as any, {} as any)

    expect(controller.guard({
      name: 'patrol_delete_step',
      arguments: { inspectionId: 'important-flow', stepId: 'step-001' },
    })).toBeUndefined()
    expect(controller.guard({
      name: 'patrol_rewrite_flow_path',
      arguments: { inspectionId: 'important-flow', keptStepIds: ['step-002'] },
    })).toBeUndefined()
  })

  it('does not block non-destructive inspection or targeted reteaching tools', () => {
    const controller = createFlowMutationConsentController()
    expect(controller.guard({ name: 'patrol_show', arguments: { inspectionId: 'important-flow' } })).toBeUndefined()
    expect(controller.guard({ name: 'patrol_run_flow', arguments: { inspectionId: 'important-flow' } })).toBeUndefined()
    expect(controller.guard({ name: 'patrol_reteach_browser_step', arguments: { inspectionId: 'important-flow', stepId: 'step-003' } })).toBeUndefined()
  })
})
