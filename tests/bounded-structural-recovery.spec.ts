import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { PatrolRunner } from '../src/runner.ts'
import { PatrolStore } from '../src/store.ts'
import {
  findAdaptiveClickPathPlan,
  findChecklistClickTargetForTask,
  resolveRecordedClickTask,
} from '../src/structural-recovery.ts'
import type { InspectionDefinition, InspectionStep, ToolStep } from '../src/types.ts'

const at = '2026-01-01T00:00:00.000Z'
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function clickStep(
  id: string,
  name: string,
  selector: string,
  taskHint?: string,
  locatorText?: string,
): ToolStep {
  return {
    id,
    kind: 'tool',
    name,
    tool: 'browser_click',
    arguments: { selector },
    ...(taskHint === undefined ? {} : { taskHint }),
    ...(locatorText === undefined ? {} : { locator: { text: locatorText } }),
    recordedAt: at,
  }
}

function readStep(id = 'step-003'): ToolStep {
  return {
    id,
    kind: 'tool',
    name: '读取当前页面',
    tool: 'browser_read_page',
    arguments: {},
    recordedAt: at,
  }
}

function definition(steps: InspectionStep[], checklist: string[]): InspectionDefinition {
  return {
    schemaVersion: '0.2',
    id: 'bounded-structural-recovery',
    name: 'bounded structural recovery',
    description: 'test',
    status: 'ready',
    target: { type: 'browser', url: 'https://example.test/home' },
    expectedResult: 'target opened',
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

function oneGapDefinition(): InspectionDefinition {
  const first = clickStep('step-001', '点击运维', '#ops', '点击运维', '运维')
  const current = clickStep('step-002', '点击 RDP', '#old-rdp', '点击主机运维', 'RDP')
  return definition(
    [first, current, readStep()],
    ['点击运维', '点击主机运维', '点击RDP', '读取当前页面'],
  )
}

async function runnerFixture(execute: (input: { name: string; arguments: any }) => Promise<any>) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-bounded-path-'))
  roots.push(root)
  const store = new PatrolStore(root)
  await store.init()
  const ctx = { tools: { execute } } as unknown as Context
  const runner = new PatrolRunner(ctx, store, { reportMaxChars: 30000 })
  const exec = {
    token: Symbol('bounded-path-parent'),
    rootCallId: 'root',
    signal: new AbortController().signal,
  } as unknown as ToolRunContext
  return { runner, exec }
}

describe('bounded checklist structural recovery', () => {
  it('recognizes that an order-bound taskHint belongs to an earlier missing click', () => {
    const def = oneGapDefinition()
    const current = def.steps[1] as ToolStep

    expect(resolveRecordedClickTask(def, current)).toBe('点击RDP')
    expect(findAdaptiveClickPathPlan(def, current)).toEqual({
      previousTask: '点击运维',
      missingTasks: ['点击主机运维'],
      currentTask: '点击RDP',
    })
  })

  it('allows at most two missing intermediate click tasks', () => {
    const first = clickStep('step-001', '点击运维', '#ops', '点击运维', '运维')
    const current = clickStep('step-002', '点击 RDP', '#old-rdp', '点击系统管理', 'RDP')
    const twoMissing = definition(
      [first, current],
      ['点击运维', '点击系统管理', '点击主机运维', '点击RDP'],
    )
    expect(findAdaptiveClickPathPlan(twoMissing, current)?.missingTasks).toEqual([
      '点击系统管理',
      '点击主机运维',
    ])

    const threeMissing = definition(
      [first, current],
      ['点击运维', '点击系统管理', '点击资源中心', '点击主机运维', '点击RDP'],
    )
    expect(findAdaptiveClickPathPlan(threeMissing, current)).toBeUndefined()
  })

  it('does not invent a path across checkpoint or authentication/input boundaries', () => {
    const first = clickStep('step-001', '点击运维', '#ops', '点击运维', '运维')
    const checkpoint: InspectionStep = {
      id: 'step-002',
      kind: 'checkpoint',
      name: '人工确认',
      prompt: '确认后继续',
      reason: 'approval',
      recordedAt: at,
    }
    const current = clickStep('step-003', '点击 RDP', '#old-rdp', '点击主机运维', 'RDP')
    const def = definition(
      [first, checkpoint, current],
      ['点击运维', '点击主机运维', '点击RDP'],
    )
    expect(findAdaptiveClickPathPlan(def, current)).toBeUndefined()
  })

  it('rejects destructive or representational missing-path tasks', () => {
    const first = clickStep('step-001', '点击运维', '#ops', '点击运维', '运维')
    const current = clickStep('step-002', '点击 RDP', '#old-rdp', '点击删除账户', 'RDP')
    const def = definition(
      [first, current],
      ['点击运维', '点击删除账户', '点击RDP'],
    )
    expect(findAdaptiveClickPathPlan(def, current)).toBeUndefined()
  })

  it('reuses the existing unique-safe-target matcher for inserted tasks', () => {
    const def = oneGapDefinition()
    const current = def.steps[1] as ToolStep
    const target = findChecklistClickTargetForTask(def, current, '点击主机运维', {
      elements: [
        { tag: 'a', role: 'link', text: '主机运维', selector: '#host-ops' },
        { tag: 'a', role: 'link', text: '其他页面', selector: '#other' },
      ],
    })
    expect(target?.selector).toBe('#host-ops')
  })

  it('inserts one missing safe click, then executes the recorded later task and continues the Runbook', async () => {
    let phase = 0
    const calls: Array<{ name: string; arguments: any }> = []
    const { runner, exec } = await runnerFixture(async input => {
      calls.push(input)
      if (input.name === 'browser_click' && input.arguments.selector === '#ops') {
        return {
          isError: false,
          value: { ok: true, selector: '#ops' },
          content: [{ type: 'text', text: 'opened operations' }],
        }
      }
      if (input.name === 'browser_click' && input.arguments.selector === '#old-rdp') {
        return {
          isError: true,
          error: new Error('element not found in any accessible frame: #old-rdp'),
          value: {},
          content: [{ type: 'text', text: 'stale RDP selector' }],
        }
      }
      if (input.name === 'browser_snapshot') {
        return {
          isError: false,
          value: phase === 0
            ? {
                ok: true,
                elements: [
                  { tag: 'a', role: 'link', text: '主机运维', selector: '#host-ops' },
                  { tag: 'a', role: 'link', text: '其他页面', selector: '#other' },
                ],
              }
            : {
                ok: true,
                elements: [
                  { tag: 'button', role: 'button', text: 'RDP', selector: '#rdp-new' },
                  { tag: 'a', role: 'link', text: '主机信息', selector: '#host-info' },
                ],
              },
          content: [{ type: 'text', text: 'snapshot' }],
        }
      }
      if (input.name === 'browser_click' && input.arguments.selector === '#host-ops') {
        phase = 1
        return {
          isError: false,
          value: { ok: true, selector: '#host-ops' },
          content: [{ type: 'text', text: 'opened host operations' }],
        }
      }
      if (input.name === 'browser_click' && input.arguments.selector === '#rdp-new') {
        return {
          isError: false,
          value: { ok: true, selector: '#rdp-new' },
          content: [{ type: 'text', text: 'opened RDP' }],
        }
      }
      if (input.name === 'browser_read_page') {
        return {
          isError: false,
          value: { ok: true, text: 'RDP 页面' },
          content: [{ type: 'text', text: 'RDP 页面' }],
        }
      }
      throw new Error(`unexpected tool ${input.name}`)
    })

    const def = oneGapDefinition()
    const before = JSON.stringify(def.steps)
    const { report } = await runner.run(def, exec)

    expect(report.status).toBe('passed')
    expect(report.results[1]).toMatchObject({
      stepId: 'step-002',
      status: 'passed',
      healedSelector: '#rdp-new',
    })
    expect(report.results[1]?.output).toMatch(/inserted bounded checklist path/i)
    expect(report.results[1]?.output).toContain('点击主机运维 -> #host-ops')
    expect(report.warnings?.join('\n')).toMatch(/bounded checklist recovery path/i)
    expect(report.results[2]).toMatchObject({ stepId: 'step-003', status: 'passed' })
    expect(JSON.stringify(def.steps)).toBe(before)
    expect(calls.map(call => `${call.name}:${String(call.arguments.selector ?? '')}`)).toEqual([
      'browser_click:#ops',
      'browser_click:#old-rdp',
      'browser_snapshot:',
      'browser_click:#host-ops',
      'browser_snapshot:',
      'browser_click:#rdp-new',
      'browser_read_page:',
    ])
  })

  it('waits in bounded stages when a recovered click needs time before the next task appears', async () => {
    let phase = 0
    let postRecoverySnapshots = 0
    const calls: Array<{ name: string; arguments: any }> = []
    const { runner, exec } = await runnerFixture(async input => {
      calls.push(input)
      if (input.name === 'browser_click' && input.arguments.selector === '#ops') {
        return { isError: false, value: { ok: true }, content: [{ type: 'text', text: 'opened operations' }] }
      }
      if (input.name === 'browser_click' && input.arguments.selector === '#old-rdp') {
        return {
          isError: true,
          error: new Error('element not found in any accessible frame: #old-rdp'),
          value: {},
          content: [{ type: 'text', text: 'stale RDP selector' }],
        }
      }
      if (input.name === 'browser_snapshot') {
        if (phase === 0) {
          return {
            isError: false,
            value: { ok: true, elements: [{ tag: 'a', role: 'link', text: '主机运维', selector: '#host-ops' }] },
            content: [{ type: 'text', text: 'host operations target' }],
          }
        }
        postRecoverySnapshots += 1
        return {
          isError: false,
          value: postRecoverySnapshots === 1
            ? { ok: true, elements: [{ tag: 'div', role: 'button', text: '正在加载', selector: '#loading' }] }
            : { ok: true, elements: [{ tag: 'button', role: 'button', text: 'RDP', selector: '#rdp-new' }] },
          content: [{ type: 'text', text: 'post recovery snapshot' }],
        }
      }
      if (input.name === 'browser_click' && input.arguments.selector === '#host-ops') {
        phase = 1
        return { isError: false, value: { ok: true }, content: [{ type: 'text', text: 'opened host operations' }] }
      }
      if (input.name === 'browser_wait') {
        return { isError: false, value: { ok: true, timeoutMs: input.arguments.timeoutMs }, content: [{ type: 'text', text: 'waited' }] }
      }
      if (input.name === 'browser_click' && input.arguments.selector === '#rdp-new') {
        return { isError: false, value: { ok: true }, content: [{ type: 'text', text: 'opened RDP' }] }
      }
      if (input.name === 'browser_read_page') {
        return { isError: false, value: { ok: true, text: 'RDP 页面' }, content: [{ type: 'text', text: 'RDP 页面' }] }
      }
      throw new Error(`unexpected tool ${input.name}`)
    })

    const { report } = await runner.run(oneGapDefinition(), exec)

    expect(report.status).toBe('passed')
    expect(calls.map(call => `${call.name}:${String(call.arguments.timeoutMs ?? call.arguments.selector ?? '')}`)).toContain('browser_wait:150')
    expect(postRecoverySnapshots).toBe(2)
  })

  it('fails closed after a partially recovered path instead of guessing the remaining route', async () => {
    let phase = 0
    const calls: Array<{ name: string; arguments: any }> = []
    const { runner, exec } = await runnerFixture(async input => {
      calls.push(input)
      if (input.name === 'browser_click' && input.arguments.selector === '#ops') {
        return {
          isError: false,
          value: { ok: true },
          content: [{ type: 'text', text: 'opened operations' }],
        }
      }
      if (input.name === 'browser_click' && input.arguments.selector === '#old-rdp') {
        return {
          isError: true,
          error: new Error('element not found in any accessible frame: #old-rdp'),
          value: {},
          content: [{ type: 'text', text: 'stale RDP selector' }],
        }
      }
      if (input.name === 'browser_snapshot') {
        return {
          isError: false,
          value: phase === 0
            ? { ok: true, elements: [{ tag: 'a', role: 'link', text: '系统管理', selector: '#system' }] }
            : {
                ok: true,
                elements: [
                  { tag: 'a', role: 'link', text: '主机运维（主）', selector: '#host-a' },
                  { tag: 'a', role: 'link', text: '主机运维（备用）', selector: '#host-b' },
                ],
              },
          content: [{ type: 'text', text: 'snapshot' }],
        }
      }
      if (input.name === 'browser_click' && input.arguments.selector === '#system') {
        phase = 1
        return {
          isError: false,
          value: { ok: true },
          content: [{ type: 'text', text: 'opened system management' }],
        }
      }
      if (input.name === 'browser_wait') {
        return {
          isError: false,
          value: { ok: true, timeoutMs: input.arguments.timeoutMs },
          content: [{ type: 'text', text: 'waited for bounded settle' }],
        }
      }
      throw new Error(`unexpected tool ${input.name}`)
    })

    const first = clickStep('step-001', '点击运维', '#ops', '点击运维', '运维')
    const current = clickStep('step-002', '点击 RDP', '#old-rdp', '点击系统管理', 'RDP')
    const def = definition(
      [first, current, readStep()],
      ['点击运维', '点击系统管理', '点击主机运维', '点击RDP', '读取当前页面'],
    )

    const { report } = await runner.run(def, exec)

    expect(report.status).toBe('failed')
    expect(report.results[1]?.error).toMatch(/stopped fail-closed/i)
    expect(report.results[1]?.output).toContain('点击系统管理 -> #system')
    expect(calls.map(call => `${call.name}:${String(call.arguments.timeoutMs ?? call.arguments.selector ?? '')}`)).toEqual([
      'browser_click:#ops',
      'browser_click:#old-rdp',
      'browser_snapshot:',
      'browser_click:#system',
      'browser_snapshot:',
      'browser_wait:150',
      'browser_snapshot:',
      'browser_wait:350',
      'browser_snapshot:',
      'browser_wait:700',
      'browser_snapshot:',
    ])
  })

  it('uses the recorded semantic task for ordinary stale-click fallback instead of a misbound earlier taskHint', async () => {
    const calls: Array<{ name: string; arguments: any }> = []
    const { runner, exec } = await runnerFixture(async input => {
      calls.push(input)
      if (input.name === 'browser_click' && input.arguments.selector === '#old-rdp') {
        return {
          isError: true,
          error: new Error('element not found in any accessible frame: #old-rdp'),
          value: {},
          content: [{ type: 'text', text: 'stale RDP selector' }],
        }
      }
      if (input.name === 'browser_snapshot') {
        return {
          isError: false,
          value: {
            ok: true,
            elements: [
              { tag: 'a', role: 'link', text: '主机运维', selector: '#host-ops' },
              { tag: 'button', role: 'button', text: 'RDP', selector: '#rdp-new' },
            ],
          },
          content: [{ type: 'text', text: 'snapshot' }],
        }
      }
      if (input.name === 'browser_click' && input.arguments.selector === '#rdp-new') {
        return {
          isError: false,
          value: { ok: true },
          content: [{ type: 'text', text: 'clicked RDP' }],
        }
      }
      throw new Error(`unexpected tool ${input.name}`)
    })

    const current = clickStep('step-001', '点击 RDP', '#old-rdp', '点击主机运维')
    const def = definition(
      [current],
      ['点击运维', '点击主机运维', '点击RDP'],
    )
    const { report } = await runner.run(def, exec)

    expect(report.status).toBe('passed')
    expect(report.results[0]).toMatchObject({ healedSelector: '#rdp-new' })
    expect(calls.map(call => `${call.name}:${String(call.arguments.selector ?? '')}`)).toEqual([
      'browser_click:#old-rdp',
      'browser_snapshot:',
      'browser_click:#rdp-new',
    ])
  })
})