import { describe, expect, it } from 'vitest'
import { checklistTaskForStep, findAdaptiveClickRecovery } from '../src/adaptive-recovery.ts'
import { bindChecklistTasks } from '../src/flow-optimizer.ts'
import { findAdaptiveClickPathPlan } from '../src/structural-recovery.ts'
import type { InspectionDefinition, ToolStep } from '../src/types.ts'

const at = '2026-01-01T00:00:00.000Z'

function click(id: string, name: string, selector: string, taskHint?: string): ToolStep {
  return {
    id,
    kind: 'tool',
    name,
    tool: 'browser_click',
    arguments: { selector },
    locator: { text: name.replace(/^点击|^进入/, '') },
    ...(taskHint === undefined ? {} : { taskHint }),
    recordedAt: at,
  }
}

function definition(steps: ToolStep[], checklist: string[]): InspectionDefinition {
  return {
    schemaVersion: '0.2',
    id: 'adaptive-audit',
    name: 'adaptive audit',
    description: 'test',
    status: 'ready',
    target: { type: 'browser', url: 'https://example.test/' },
    expectedResult: 'done',
    artifacts: [],
    auth: { mode: 'none' },
    schedule: null,
    steps,
    metadata: {
      createdAt: at,
      updatedAt: at,
      taskChecklist: checklist,
    },
  }
}

describe('adaptive recovery audit hardening', () => {
  it('treats 进入 instructions as browser click tasks for legacy recovery binding', () => {
    const step = click('step-001', '进入主机运维', '#host-ops')
    const value = definition([step], ['进入主机运维'])

    expect(checklistTaskForStep(value, step)).toBe('进入主机运维')
  })

  it('binds 进入 instructions during flow optimization as click business tasks', () => {
    const step = click('raw-001', '进入主机运维', '#host-ops')
    delete step.taskHint
    const value = definition([step], ['进入主机运维'])

    bindChecklistTasks(value)

    expect((value.steps[0] as ToolStep).taskHint).toBe('进入主机运维')
  })

  it('never semantically retargets confirmation, submit, or save actions', () => {
    for (const task of ['点击确认修改', '点击提交工单', '点击保存配置']) {
      const step = click('step-001', task, '#old-action', task)
      const value = definition([step], [task])
      expect(findAdaptiveClickRecovery(value, step, {
        elements: [
          { tag: 'button', role: 'button', text: task.replace(/^点击/, ''), selector: '#new-action' },
        ],
      })).toBeUndefined()
    }
  })

  it('does not reinterpret a select instruction as an invented structural browser click', () => {
    const previous = click('step-001', '点击运维', '#ops', '点击运维')
    const current = click('step-002', '点击RDP', '#rdp', '点击RDP')
    const value = definition([previous, current], [
      '点击运维',
      '选择目标主机',
      '点击RDP',
    ])

    expect(findAdaptiveClickPathPlan(value, current)).toBeUndefined()
  })
})
