import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { findAdaptiveClickRecovery } from '../src/adaptive-recovery.ts'
import { PatrolRunner } from '../src/runner.ts'
import { PatrolStore } from '../src/store.ts'
import type { InspectionDefinition, ToolStep } from '../src/types.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const at = '2026-01-01T00:00:00.000Z'

function clickStep(taskHint = '点击我的工作台'): ToolStep {
  return {
    id: 'step-001',
    kind: 'tool',
    name: '打开工作台',
    tool: 'browser_click',
    arguments: { selector: '#old-workbench' },
    taskHint,
    recordedAt: at,
  }
}

function definition(step = clickStep()): InspectionDefinition {
  return {
    schemaVersion: '0.2',
    id: 'task-click-recovery',
    name: 'task click recovery',
    description: 'test',
    status: 'ready',
    target: { type: 'browser', url: 'https://example.test/home' },
    expectedResult: 'workbench opened',
    artifacts: [],
    auth: { mode: 'none' },
    schedule: null,
    steps: [step, {
      id: 'step-002',
      kind: 'tool',
      name: '读取工作台',
      tool: 'browser_read_page',
      arguments: {},
      recordedAt: at,
    }],
    metadata: {
      createdAt: at,
      updatedAt: at,
      taskChecklist: ['点击我的工作台', '读取工作台'],
    },
  }
}

const snapshot = {
  url: 'https://example.test/home',
  elements: [
    { tag: 'a', role: 'link', text: '我的工作台（3）', selector: '#new-workbench' },
    { tag: 'a', role: 'link', text: '其他页面', selector: '#other' },
  ],
}

describe('task-guided click recovery', () => {
  it('uses one concrete checklist target when the stale click has no semantic locator', () => {
    expect(findAdaptiveClickRecovery(definition(), clickStep(), snapshot)).toEqual({
      selector: '#new-workbench',
      reason: 'unique clickable target matching checklist instruction "点击我的工作台"',
      task: '点击我的工作台',
    })
  })

  it('fails closed for generic confirmation tasks', () => {
    const step = clickStep('点击确定')
    expect(findAdaptiveClickRecovery(definition(step), step, {
      elements: [{ tag: 'button', role: 'button', text: '确定', selector: '#confirm' }],
    })).toBeUndefined()
  })

  it('fails closed for dangerous checklist actions', () => {
    const step = clickStep('点击删除账户')
    expect(findAdaptiveClickRecovery(definition(step), step, {
      elements: [{ tag: 'button', role: 'button', text: '删除账户', selector: '#delete' }],
    })).toBeUndefined()
  })

  it('fails closed when two clickable targets match the checklist instruction', () => {
    const step = clickStep()
    expect(findAdaptiveClickRecovery(definition(step), step, {
      elements: [
        { tag: 'a', role: 'link', text: '我的工作台（主）', selector: '#a' },
        { tag: 'a', role: 'link', text: '我的工作台（备用）', selector: '#b' },
      ],
    })).toBeUndefined()
  })

  it('recovers the stale click from the checklist and continues the original Runbook', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-task-click-'))
    roots.push(root)
    const store = new PatrolStore(root)
    await store.init()
    const calls: Array<{ name: string; arguments: any }> = []
    const ctx = {
      tools: {
        execute: async (input: { name: string; arguments: any }) => {
          calls.push(input)
          if (input.name === 'browser_click' && input.arguments.selector === '#old-workbench') {
            return {
              isError: true,
              error: new Error('element not found in any accessible frame: #old-workbench'),
              value: {},
              content: [{ type: 'text', text: 'old selector missing' }],
            }
          }
          if (input.name === 'browser_snapshot') {
            return {
              isError: false,
              value: { ok: true, ...snapshot },
              content: [{ type: 'text', text: 'snapshot' }],
            }
          }
          if (input.name === 'browser_click' && input.arguments.selector === '#new-workbench') {
            return {
              isError: false,
              value: { ok: true, selector: '#new-workbench' },
              content: [{ type: 'text', text: 'clicked recovered workbench' }],
            }
          }
          if (input.name === 'browser_read_page') {
            return {
              isError: false,
              value: { ok: true, text: '工作台内容' },
              content: [{ type: 'text', text: '工作台内容' }],
            }
          }
          throw new Error(`unexpected tool ${input.name}`)
        },
      },
    } as unknown as Context
    const runner = new PatrolRunner(ctx, store, { reportMaxChars: 30000 })
    const exec = {
      token: Symbol('task-click-parent'),
      rootCallId: 'root',
      signal: new AbortController().signal,
    } as unknown as ToolRunContext
    const def = definition()
    const before = JSON.stringify(def.steps)

    const { report } = await runner.run(def, exec)

    expect(report.status).toBe('passed')
    expect(report.results[0]).toMatchObject({
      stepId: 'step-001',
      status: 'passed',
      healedSelector: '#new-workbench',
    })
    expect(report.results[1]).toMatchObject({ stepId: 'step-002', status: 'passed' })
    expect(report.warnings?.join('\n')).toMatch(/recovered selector drift/i)
    expect(JSON.stringify(def.steps)).toBe(before)
    expect(calls.map(call => call.name)).toEqual([
      'browser_click',
      'browser_snapshot',
      'browser_click',
      'browser_read_page',
    ])
  })
})
