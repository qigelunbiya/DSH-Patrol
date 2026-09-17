import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { findAdaptiveSelectorRecovery } from '../src/adaptive-recovery.ts'
import { PatrolRunner } from '../src/runner.ts'
import { PatrolStore } from '../src/store.ts'
import type { InspectionDefinition, ToolStep } from '../src/types.ts'

const at = '2026-01-01T00:00:00.000Z'
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function definition(steps: ToolStep[], checklist: string[]): InspectionDefinition {
  return {
    schemaVersion: '0.2',
    id: 'replay-edge-hardening',
    name: 'replay edge hardening',
    description: 'test',
    status: 'ready',
    target: { type: 'browser', url: 'https://example.test/home' },
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

function expectedClick(): ToolStep {
  return {
    id: 'step-001',
    kind: 'tool',
    name: '打开工单详情',
    tool: 'browser_click',
    arguments: { selector: '#stale' },
    locator: { text: '工单详情', role: 'button', tag: 'button' },
    expectation: { mode: 'contains', value: '工单详情页面', caseSensitive: false },
    taskHint: '点击工单详情',
    recordedAt: at,
  }
}

async function runnerFixture(execute: (input: { name: string; arguments: any }) => Promise<any>) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-replay-edge-'))
  roots.push(root)
  const store = new PatrolStore(root)
  await store.init()
  const ctx = { tools: { execute } } as unknown as Context
  const runner = new PatrolRunner(ctx, store, { reportMaxChars: 30000 })
  const exec = {
    token: Symbol('replay-edge-parent'),
    rootCallId: 'root',
    signal: new AbortController().signal,
  } as unknown as ToolRunContext
  return { runner, exec }
}

describe('adaptive replay edge hardening', () => {
  it('heals an expectation-bearing click before mutation when the old selector now belongs to a different control', async () => {
    const calls: Array<{ name: string; arguments: any }> = []
    const { runner, exec } = await runnerFixture(async input => {
      calls.push(input)
      if (input.name === 'browser_snapshot') {
        return {
          isError: false,
          value: {
            ok: true,
            elements: [
              { tag: 'button', role: 'button', text: '删除账户', selector: '#stale' },
              { tag: 'button', role: 'button', text: '工单详情', selector: '#ticket-detail' },
            ],
          },
          content: [{ type: 'text', text: 'snapshot' }],
        }
      }
      if (input.name === 'browser_click' && input.arguments.selector === '#ticket-detail') {
        return {
          isError: false,
          value: { ok: true, selector: '#ticket-detail' },
          content: [{ type: 'text', text: 'opened ticket detail' }],
        }
      }
      if (input.name === 'browser_read_page') {
        return {
          isError: false,
          value: { ok: true, text: '工单详情页面', title: '工单详情', url: 'https://example.test/ticket/1' },
          content: [{ type: 'text', text: '工单详情页面' }],
        }
      }
      throw new Error(`unexpected tool ${input.name} ${JSON.stringify(input.arguments)}`)
    })

    const def = definition([expectedClick()], ['点击工单详情'])
    const before = JSON.stringify(def.steps)
    const { report } = await runner.run(def, exec)

    expect(report.status).toBe('passed')
    expect(report.results[0]).toMatchObject({
      status: 'passed',
      healedSelector: '#ticket-detail',
    })
    expect(calls.some(call => call.name === 'browser_click' && call.arguments.selector === '#stale')).toBe(false)
    expect(calls.map(call => `${call.name}:${String(call.arguments.selector ?? '')}`)).toEqual([
      'browser_snapshot:',
      'browser_click:#ticket-detail',
      'browser_read_page:',
    ])
    expect(JSON.stringify(def.steps)).toBe(before)
  })

  it('fails closed before clicking when a still-existing selector has drifted and no unique semantic replacement exists', async () => {
    const calls: Array<{ name: string; arguments: any }> = []
    const { runner, exec } = await runnerFixture(async input => {
      calls.push(input)
      if (input.name === 'browser_snapshot') {
        return {
          isError: false,
          value: {
            ok: true,
            elements: [
              { tag: 'button', role: 'button', text: '删除账户', selector: '#stale' },
              { tag: 'button', role: 'button', text: '其他操作', selector: '#other' },
            ],
          },
          content: [{ type: 'text', text: 'snapshot' }],
        }
      }
      throw new Error(`unexpected tool ${input.name}`)
    })

    const { report } = await runner.run(definition([expectedClick()], ['点击工单详情']), exec)

    expect(report.status).toBe('failed')
    expect(report.results[0]?.error).toMatch(/Refused to click/i)
    expect(calls.map(call => call.name)).toEqual(['browser_snapshot'])
  })

  it('can recover a username field whose only useful semantic cue is placeholder text', () => {
    const step: ToolStep = {
      id: 'step-001',
      kind: 'tool',
      name: '输入用户名',
      tool: 'browser_type',
      arguments: { selector: '#old-user', text: 'public-user' },
      taskHint: '输入用户名',
      recordedAt: at,
    }
    const def = definition([step], ['输入用户名'])

    const recovered = findAdaptiveSelectorRecovery(def, step, {
      elements: [
        { tag: 'input', type: 'text', selector: '#new-user', text: '请输入用户名' },
      ],
    })

    expect(recovered).toMatchObject({ selector: '#new-user' })
  })

  it('keeps placeholder semantics available in every snapshot transport', async () => {
    const paths = [
      '../browser-extension/content.js',
      '../browser-extension/frame-content.js',
      '../browser-extension/snapshot-resilient.js',
    ]
    for (const relative of paths) {
      const source = await readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
      expect(source).toContain("getAttribute('placeholder')")
    }
  })
})
