import { describe, expect, it } from 'vitest'
import { compactTeachingFlow, selectSuccessfulTeachingPath } from '../src/flow-optimizer.ts'
import type { InspectionDefinition, InspectionStep } from '../src/types.ts'

function definition(steps: InspectionStep[]): InspectionDefinition {
  return {
    schemaVersion: '0.2',
    id: 'compact-test',
    name: 'Compact test',
    description: 'test',
    status: 'draft',
    target: { type: 'browser', url: 'https://example.test' },
    expectedResult: 'done',
    artifacts: ['page-text', 'screenshot'],
    auth: { mode: 'none' },
    schedule: null,
    steps,
    metadata: {
      createdAt: '2026-09-02T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
    },
  }
}

const tool = (id: string, name: string, browserTool: string, extra: Partial<InspectionStep> = {}): InspectionStep => ({
  id,
  kind: 'tool',
  name,
  tool: browserTool,
  arguments: {},
  recordedAt: `2026-09-02T00:00:${id.slice(-3)}Z`,
  ...extra,
} as InspectionStep)

describe('flow compaction', () => {
  it('removes teaching probes while keeping real actions and final requested outputs', () => {
    const value = definition([
      tool('step-001', 'Navigate', 'browser_navigate', { arguments: { url: 'https://example.test' } } as Partial<InspectionStep>),
      tool('step-002', 'Probe snapshot', 'browser_snapshot'),
      tool('step-003', 'Probe count', 'browser_count'),
      tool('step-004', 'Early read', 'browser_read_page', { artifact: 'page-text' } as Partial<InspectionStep>),
      tool('step-005', 'Click login', 'browser_click'),
      tool('step-006', 'Early screenshot', 'browser_screenshot', { artifact: 'screenshot' } as Partial<InspectionStep>),
      tool('step-007', 'Final read', 'browser_read_page', { artifact: 'page-text' } as Partial<InspectionStep>),
      tool('step-008', 'Final screenshot', 'browser_screenshot', { artifact: 'screenshot' } as Partial<InspectionStep>),
    ])

    const result = compactTeachingFlow(value)

    expect(result).toEqual({ originalSteps: 8, finalSteps: 4, removedSteps: 4 })
    expect(value.steps.map(step => step.tool)).toEqual([
      'browser_navigate',
      'browser_click',
      'browser_read_page',
      'browser_screenshot',
    ])
    expect(value.steps.map(step => step.id)).toEqual(['step-001', 'step-002', 'step-003', 'step-004'])
  })

  it('keeps an observational source referenced by a conditional action and rewrites its id', () => {
    const value = definition([
      tool('step-001', 'Probe snapshot', 'browser_snapshot'),
      tool('step-002', 'Login state', 'browser_read_page'),
      tool('step-003', 'Unused count', 'browser_count'),
      tool('step-004', 'Conditional login click', 'browser_click', {
        when: {
          sourceStepId: 'step-002',
          mode: 'contains',
          value: '登录',
          caseSensitive: false,
        },
      } as Partial<InspectionStep>),
    ])

    const result = compactTeachingFlow(value)

    expect(result.finalSteps).toBe(2)
    expect(value.steps[0]).toMatchObject({ id: 'step-001', tool: 'browser_read_page' })
    expect(value.steps[1]).toMatchObject({
      id: 'step-002',
      tool: 'browser_click',
      when: { sourceStepId: 'step-001' },
    })
  })

  it('drops an abandoned teaching round after a clean reset to the target page', () => {
    const value = definition([
      tool('step-001', 'First navigate', 'browser_navigate', { arguments: { url: 'https://example.test/' } } as Partial<InspectionStep>),
      tool('step-002', 'Wrong menu', 'browser_click', { arguments: { selector: '#wrong' } } as Partial<InspectionStep>),
      tool('step-003', 'Probe wrong page', 'browser_snapshot'),
      tool('step-004', 'Reset to target', 'browser_navigate', { arguments: { url: 'https://example.test' } } as Partial<InspectionStep>),
      tool('step-005', 'Correct menu', 'browser_click', { arguments: { selector: '#correct' } } as Partial<InspectionStep>),
      tool('step-006', 'Final read', 'browser_read_page', { artifact: 'page-text' } as Partial<InspectionStep>),
      tool('step-007', 'Final screenshot', 'browser_screenshot', { artifact: 'screenshot' } as Partial<InspectionStep>),
    ])

    const result = compactTeachingFlow(value)

    expect(result).toEqual({ originalSteps: 7, finalSteps: 4, removedSteps: 3 })
    expect(value.steps.map(step => step.name)).toEqual(['Reset to target', 'Correct menu', 'Final read', 'Final screenshot'])
  })

  it('drops an input value that is corrected before the next interaction boundary', () => {
    const value = definition([
      tool('step-001', 'Navigate', 'browser_navigate', { arguments: { url: 'https://example.test' } } as Partial<InspectionStep>),
      tool('step-002', 'Wrong username', 'browser_type', { arguments: { selector: '#user', text: 'wrong' } } as Partial<InspectionStep>),
      tool('step-003', 'Correct username', 'browser_type', { arguments: { selector: '#user', text: 'right' } } as Partial<InspectionStep>),
      tool('step-004', 'Submit', 'browser_click', { arguments: { selector: '#submit' } } as Partial<InspectionStep>),
      tool('step-005', 'Final read', 'browser_read_page', { artifact: 'page-text' } as Partial<InspectionStep>),
      tool('step-006', 'Final screenshot', 'browser_screenshot', { artifact: 'screenshot' } as Partial<InspectionStep>),
    ])

    compactTeachingFlow(value)
    expect(value.steps.map(step => step.name)).toEqual(['Navigate', 'Correct username', 'Submit', 'Final read', 'Final screenshot'])
  })

  it('collapses repeated identical clicks from failed captcha retry loops', () => {
    const value = definition([
      tool('step-001', 'Navigate', 'browser_navigate', { arguments: { url: 'https://example.test' } } as Partial<InspectionStep>),
      tool('step-002', 'Fill username', 'browser_type', { arguments: { selector: '#user', text: 'fangzheming' } } as Partial<InspectionStep>),
      tool('step-003', 'Fill password', 'browser_type_transient_ref', { arguments: { selector: '#password', transientRef: 'PATROL_SECRET_ABC' } } as Partial<InspectionStep>),
      tool('step-004', 'Click login', 'browser_click', { arguments: { selector: '#login' } } as Partial<InspectionStep>),
      tool('step-005', 'Click login', 'browser_click', { arguments: { selector: '#login' } } as Partial<InspectionStep>),
      tool('step-006', 'Click login', 'browser_click', { arguments: { selector: '#login' } } as Partial<InspectionStep>),
      tool('step-007', 'Final read', 'browser_read_page', { artifact: 'page-text' } as Partial<InspectionStep>),
      tool('step-008', 'Final screenshot', 'browser_screenshot', { artifact: 'screenshot' } as Partial<InspectionStep>),
    ])

    compactTeachingFlow(value)

    expect(value.steps.map(step => step.name)).toEqual([
      'Navigate',
      'Fill username',
      'Fill password',
      'Click login',
      'Final read',
      'Final screenshot',
    ])
  })

  it('collapses repeated redirect navigations and waits before the successful route', () => {
    const value = definition([
      tool('step-001', '访问入口', 'browser_navigate', {
        arguments: { url: 'http://172.21.9.122/com-sso/v2?returnUrl=%2Fcom-portal%2Fhome' },
      } as Partial<InspectionStep>),
      tool('step-002', '等待登录页加载', 'browser_wait', { arguments: { timeoutMs: 15000 } } as Partial<InspectionStep>),
      tool('step-003', '再次等待页面刷新', 'browser_wait', { arguments: { timeoutMs: 10000 } } as Partial<InspectionStep>),
      tool('step-004', '重复访问入口', 'browser_navigate', {
        arguments: { url: 'http://172.21.9.122/com-sso/v2?returnUrl=%2Fcom-portal%2F' },
      } as Partial<InspectionStep>),
      tool('step-005', '重复等待首页加载', 'browser_wait', { arguments: { timeoutMs: 10000 } } as Partial<InspectionStep>),
      tool('step-006', '最终访问入口', 'browser_navigate', {
        arguments: { url: 'http://172.21.9.122/com-sso/v2?returnUrl=%2Fcom-portal%2Fhome' },
      } as Partial<InspectionStep>),
      tool('step-007', '点击 logo', 'browser_click', { arguments: { selector: '#logo' } } as Partial<InspectionStep>),
      tool('step-008', '读取最终页面', 'browser_read_page', { artifact: 'page-text' } as Partial<InspectionStep>),
      tool('step-009', '保存最终截图', 'browser_screenshot', { artifact: 'screenshot' } as Partial<InspectionStep>),
    ])

    compactTeachingFlow(value)

    expect(value.steps.map(step => step.name)).toEqual([
      '最终访问入口',
      '点击 logo',
      '读取最终页面',
      '保存最终截图',
    ])
  })

  it('uses the model-selected successful route instead of keeping successful wrong-branch clicks', () => {
    const value = definition([
      tool('step-001', 'Navigate', 'browser_navigate', { arguments: { url: 'https://example.test' } } as Partial<InspectionStep>),
      tool('step-002', 'Explore wrong tab', 'browser_click', { arguments: { selector: '#wrong-tab' } } as Partial<InspectionStep>),
      tool('step-003', 'Wrong page read', 'browser_read_page'),
      tool('step-004', 'Open correct tab', 'browser_click', { arguments: { selector: '#correct-tab' } } as Partial<InspectionStep>),
      tool('step-005', 'State source', 'browser_read_page'),
      tool('step-006', 'Conditional submit', 'browser_click', {
        arguments: { selector: '#submit' },
        when: { sourceStepId: 'step-005', mode: 'contains', value: 'ready', caseSensitive: false },
      } as Partial<InspectionStep>),
      tool('step-007', 'Final read', 'browser_read_page', { artifact: 'page-text' } as Partial<InspectionStep>),
      tool('step-008', 'Final screenshot', 'browser_screenshot', { artifact: 'screenshot' } as Partial<InspectionStep>),
    ])

    const result = selectSuccessfulTeachingPath(value, ['step-001', 'step-004', 'step-006'])

    expect(result).toEqual({ originalSteps: 8, finalSteps: 6, removedSteps: 2, autoKeptDependencies: 3 })
    expect(value.steps.map(step => step.name)).toEqual([
      'Navigate',
      'Open correct tab',
      'State source',
      'Conditional submit',
      'Final read',
      'Final screenshot',
    ])
    expect(value.steps[3]).toMatchObject({ when: { sourceStepId: 'step-003' } })
  })

  it('still compacts the selected path when finalization receives the whole teaching trace', () => {
    const value = definition([
      tool('step-001', '访问入口', 'browser_navigate', {
        arguments: { url: 'http://172.21.9.122/com-sso/v2?returnUrl=%2Fcom-portal%2Fhome' },
      } as Partial<InspectionStep>),
      tool('step-002', '等待登录页加载', 'browser_wait', { arguments: { timeoutMs: 15000 } } as Partial<InspectionStep>),
      tool('step-003', '重复访问入口', 'browser_navigate', {
        arguments: { url: 'http://172.21.9.122/com-sso/v2?returnUrl=%2Fcom-portal%2F' },
      } as Partial<InspectionStep>),
      tool('step-004', '重复等待首页加载', 'browser_wait', { arguments: { timeoutMs: 10000 } } as Partial<InspectionStep>),
      tool('step-005', '最终访问入口', 'browser_navigate', {
        arguments: { url: 'http://172.21.9.122/com-sso/v2?returnUrl=%2Fcom-portal%2Fhome' },
      } as Partial<InspectionStep>),
      tool('step-006', '点击 logo', 'browser_click', { arguments: { selector: '#logo' } } as Partial<InspectionStep>),
      tool('step-007', '读取最终页面', 'browser_read_page', { artifact: 'page-text' } as Partial<InspectionStep>),
      tool('step-008', '保存最终截图', 'browser_screenshot', { artifact: 'screenshot' } as Partial<InspectionStep>),
    ])

    selectSuccessfulTeachingPath(value, value.steps.map(step => step.id))

    expect(value.steps.map(step => step.name)).toEqual([
      '最终访问入口',
      '点击 logo',
      '读取最终页面',
      '保存最终截图',
    ])
  })

  it('rejects semantic clicks that have no post-click verification evidence', () => {
    const value = definition([
      tool('step-001', '访问入口', 'browser_navigate', { arguments: { url: 'https://example.test' } } as Partial<InspectionStep>),
      tool('step-002', '点击我的工作台', 'browser_click', {
        arguments: { selector: '#workbench' },
        locator: { text: '我的工作台' },
      } as Partial<InspectionStep>),
      tool('step-003', '读取首页', 'browser_read_page', { artifact: 'page-text' } as Partial<InspectionStep>),
      tool('step-004', '保存截图', 'browser_screenshot', { artifact: 'screenshot' } as Partial<InspectionStep>),
    ])

    expect(() => selectSuccessfulTeachingPath(value, ['step-001', 'step-002', 'step-003', 'step-004']))
      .toThrow(/has no post-click verification evidence/)
  })

  it('accepts a semantic click verified by automatic CURRENT-state change and strips teaching metadata', () => {
    const value = definition([
      tool('step-001', '访问入口', 'browser_navigate', { arguments: { url: 'https://example.test' } } as Partial<InspectionStep>),
      tool('step-002', '点击 Logo', 'browser_click', {
        arguments: { selector: '#logo' },
        locator: { text: '长城网际' },
        teaching: { status: 'verified', method: 'state-change', evidence: 'new interactive DOM: 登录表单' },
      } as Partial<InspectionStep>),
      tool('step-003', '读取页面', 'browser_read_page', { artifact: 'page-text' } as Partial<InspectionStep>),
      tool('step-004', '保存截图', 'browser_screenshot', { artifact: 'screenshot' } as Partial<InspectionStep>),
    ])

    expect(() => selectSuccessfulTeachingPath(value, value.steps.map(step => step.id))).not.toThrow()
    const click = value.steps.find(step => step.kind === 'tool' && step.tool === 'browser_click')
    expect(click).toBeDefined()
    expect(click?.kind === 'tool' ? click.teaching : undefined).toBeUndefined()
  })
})