import { describe, expect, it } from 'vitest'
import { checklistTaskForStep, findAdaptiveSelectorRecovery } from '../src/adaptive-recovery.ts'
import { bindChecklistTasks, compactTeachingFlow } from '../src/flow-optimizer.ts'
import type { InspectionDefinition, ToolStep } from '../src/types.ts'

const at = '2026-01-01T00:00:00.000Z'

function definition(steps: ToolStep[], checklist?: string[]): InspectionDefinition {
  return {
    schemaVersion: '0.2',
    id: 'task-binding',
    name: 'task binding',
    description: 'test',
    status: 'ready',
    target: { type: 'browser', url: 'https://example.test/login' },
    expectedResult: 'done',
    artifacts: [],
    auth: { mode: 'none' },
    schedule: null,
    steps,
    metadata: {
      createdAt: at,
      updatedAt: at,
      ...(checklist === undefined ? {} : { taskChecklist: checklist }),
    },
  }
}

function step(id: string, name: string, tool: string, arguments_: Record<string, any> = {}): ToolStep {
  return {
    id,
    kind: 'tool',
    name,
    tool,
    arguments: arguments_,
    recordedAt: at,
  }
}

describe('task checklist step binding', () => {
  it('binds compacted reusable actions to ordered business checklist instructions', () => {
    const value = definition([
      step('raw-001', '访问入口', 'browser_navigate', { url: 'https://example.test/login' }),
      step('raw-002', '输入账号', 'browser_type', { selector: '#username', text: 'user' }),
      step('raw-003', '输入登录口令', 'browser_type_credential', { selector: '#password', credentialRef: 'LOGIN_PASSWORD' }),
      step('raw-004', '点击提交', 'browser_click', { selector: '#login' }),
    ], [
      '访问登录页',
      '输入用户名',
      '输入密码',
      '点击登录',
    ])

    compactTeachingFlow(value)

    expect(value.steps).toHaveLength(4)
    expect(value.steps.map(item => item.id)).toEqual(['step-001', 'step-002', 'step-003', 'step-004'])
    expect(value.steps.map(item => item.kind === 'tool' ? item.taskHint : undefined)).toEqual([
      '访问登录页',
      '输入用户名',
      '输入密码',
      '点击登录',
    ])
  })

  it('binds explicit semantic wait checklist items to desktop_wait_for_target', () => {
    const wait = step('step-001', '等待联系人出现', 'desktop_wait_for_target', {
      source: 'auto',
      text: '测试联系人',
      timeoutMs: 10000,
    })
    const value = definition([wait], ['等待联系人出现'])

    bindChecklistTasks(value)

    expect((value.steps[0] as ToolStep).taskHint).toBe('等待联系人出现')
  })

  it('does not treat ordinary result wording containing 出现 as an extra wait requirement', () => {
    const click = step('step-001', '点击联系人', 'desktop_click_ocr_text', {
      text: '测试联系人',
    })
    const value = definition([click], ['点击联系人后出现聊天窗口'])

    compactTeachingFlow(value)

    expect(value.metadata.flowHealth?.warnings ?? []).toEqual([])
  })

  it('preserves an explicit task hint instead of overwriting it during rebinding', () => {
    const typed = step('step-001', '账号输入', 'browser_type', { selector: '#user', text: 'user' })
    typed.taskHint = '人工确认过的账号输入工序'
    const value = definition([typed], ['输入用户名'])

    bindChecklistTasks(value)

    expect((value.steps[0] as ToolStep).taskHint).toBe('人工确认过的账号输入工序')
  })

  it('leaves legacy flows without a checklist untouched', () => {
    const value = definition([
      step('step-001', '输入用户名', 'browser_type', { selector: '#username', text: 'user' }),
    ])

    bindChecklistTasks(value)

    expect((value.steps[0] as ToolStep).taskHint).toBeUndefined()
  })

  it('maps legacy typing steps to the matching checklist instruction by action order', () => {
    const username = step('step-001', 'fill field one', 'browser_type', { selector: '#field-a', text: 'user' })
    const password = step('step-002', 'fill field two', 'browser_type_credential', { selector: '#field-b', credentialRef: 'LOGIN_PASSWORD' })
    const value = definition([username, password], ['输入用户名', '输入密码'])

    expect(checklistTaskForStep(value, username)).toBe('输入用户名')
    expect(checklistTaskForStep(value, password)).toBe('输入密码')
  })

  it('uses a persisted task hint to guide recovery but still refuses verification-code improvisation', () => {
    const verification = step('step-001', 'fill current field', 'browser_type', { selector: '#old-code', text: '123' })
    verification.taskHint = '输入短信验证码'
    const value = definition([verification], ['输入短信验证码'])

    const recovery = findAdaptiveSelectorRecovery(value, verification, {
      elements: [
        { tag: 'input', type: 'text', name: 'verificationCode', selector: '#new-code' },
      ],
    })

    expect(recovery).toBeUndefined()
  })
})
