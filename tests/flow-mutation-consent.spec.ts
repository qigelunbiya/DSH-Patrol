import { describe, expect, it, vi } from 'vitest'
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
    expect(blocked).toMatch(/patrol_request_flow_change_choice/)

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

  it('accepts patrol_delete confirmed=true as the explicit whole-flow deletion gate', () => {
    const controller = createFlowMutationConsentController()

    expect(controller.guard({
      name: 'patrol_delete',
      arguments: { inspectionId: 'important-flow', confirmed: true },
    })).toBeUndefined()

    const blocked = controller.guard({
      name: 'patrol_delete',
      arguments: { inspectionId: 'important-flow', confirmed: false },
    })
    expect(blocked).toMatch(/destructive-flow guard/i)
    expect(blocked).toMatch(/confirmed=true/i)
  })

  it('renders exactly the requested three options through Harness userQuestions and applies the selected choice', async () => {
    const ask = vi.fn(async (request: any) => ({
      answers: [{ id: request.questions[0].id, selected: ['新建一份流程图'] }],
    }))
    const controller = createFlowMutationConsentController({ userQuestions: { ask } } as any)

    const result = await controller.requestChoiceTool.execute({
      inspectionId: 'important-flow',
      reason: '新需求与已有流程不完全一致',
    } as any, { signal: new AbortController().signal } as any)

    expect(ask).toHaveBeenCalledTimes(1)
    const request = ask.mock.calls[0]![0]
    expect(request.questions).toHaveLength(1)
    expect(request.questions[0].options.map((option: any) => option.label)).toEqual([
      '确定（允许一次）',
      '新建一份流程图',
      '总是确定',
    ])
    expect(result).toContain('preserve important-flow unchanged')
    expect(controller.guard({
      name: 'patrol_delete',
      arguments: { inspectionId: 'important-flow', confirmed: true },
    })).toMatch(/existing flow must remain untouched/i)
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
