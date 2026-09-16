import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { findUniqueHealingSelector } from '../src/browser.ts'
import { PatrolRunner } from '../src/runner.ts'
import { PatrolStore } from '../src/store.ts'
import type { InspectionDefinition } from '../src/types.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('semantic click selector healing', () => {
  it('accepts one harmlessly expanded accessible label', () => {
    expect(findUniqueHealingSelector({
      elements: [
        { tag: 'a', role: 'link', text: '我的工作台（3）', selector: '#workbench-new' },
      ],
    }, { text: '我的工作台', role: 'link', tag: 'a' })).toBe('#workbench-new')
  })

  it('rejects destructive text expansion instead of healing to a dangerous action', () => {
    expect(findUniqueHealingSelector({
      elements: [
        { tag: 'button', role: 'button', text: '确定删除账户', selector: '#danger' },
      ],
    }, { text: '确定', role: 'button', tag: 'button' })).toBeUndefined()
  })

  it('fails closed when the semantic target is still ambiguous', () => {
    expect(findUniqueHealingSelector({
      elements: [
        { tag: 'a', role: 'link', text: '我的工作台（3）', selector: '#workbench-a' },
        { tag: 'a', role: 'link', text: '我的工作台（备用）', selector: '#workbench-b' },
      ],
    }, { text: '我的工作台', role: 'link', tag: 'a' })).toBeUndefined()
  })

  it('lets PatrolRunner heal a stale click selector and continue the original Runbook', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-click-healing-'))
    roots.push(root)
    const store = new PatrolStore(root)
    await store.init()
    const calls: Array<{ name: string; arguments: any }> = []
    const ctx = {
      tools: {
        execute: async (input: { name: string; arguments: any }) => {
          calls.push(input)
          if (input.name === 'browser_click' && input.arguments.selector === '#workbench-old') {
            return {
              isError: true,
              error: new Error('element not found in any accessible frame: #workbench-old'),
              value: {},
              content: [{ type: 'text', text: 'missing old selector' }],
            }
          }
          if (input.name === 'browser_snapshot') {
            return {
              isError: false,
              value: {
                ok: true,
                url: 'https://example.test/home',
                elements: [
                  { tag: 'a', role: 'link', text: '我的工作台（3）', selector: '#workbench-new' },
                ],
              },
              content: [{ type: 'text', text: 'snapshot' }],
            }
          }
          if (input.name === 'browser_click' && input.arguments.selector === '#workbench-new') {
            return {
              isError: false,
              value: { ok: true, selector: '#workbench-new' },
              content: [{ type: 'text', text: 'clicked healed target' }],
            }
          }
          if (input.name === 'browser_read_page') {
            return {
              isError: false,
              value: { ok: true, text: '待办待阅工单' },
              content: [{ type: 'text', text: '待办待阅工单' }],
            }
          }
          throw new Error(`unexpected tool ${input.name}`)
        },
      },
    } as unknown as Context
    const runner = new PatrolRunner(ctx, store, { reportMaxChars: 30000 })
    const exec = {
      token: Symbol('click-heal-parent'),
      rootCallId: 'root',
      signal: new AbortController().signal,
    } as unknown as ToolRunContext
    const at = '2026-01-01T00:00:00.000Z'
    const def: InspectionDefinition = {
      schemaVersion: '0.2',
      id: 'click-heal',
      name: 'click heal',
      description: 'test',
      status: 'ready',
      target: { type: 'browser', url: 'https://example.test/home' },
      expectedResult: 'workbench visible',
      artifacts: [],
      auth: { mode: 'none' },
      schedule: null,
      steps: [
        {
          id: 'step-001',
          kind: 'tool',
          name: '点击我的工作台',
          tool: 'browser_click',
          arguments: { selector: '#workbench-old' },
          locator: { text: '我的工作台', role: 'link', tag: 'a' },
          recordedAt: at,
        },
        {
          id: 'step-002',
          kind: 'tool',
          name: '读取工作台',
          tool: 'browser_read_page',
          arguments: {},
          recordedAt: at,
        },
      ],
      metadata: {
        createdAt: at,
        updatedAt: at,
        taskChecklist: ['点击我的工作台', '读取工作台'],
      },
    }
    const original = JSON.stringify(def.steps)

    const { report } = await runner.run(def, exec)

    expect(report.status).toBe('passed')
    expect(report.results[0]).toMatchObject({
      stepId: 'step-001',
      status: 'passed',
      healedSelector: '#workbench-new',
    })
    expect(report.results[1]).toMatchObject({ stepId: 'step-002', status: 'passed' })
    expect(report.warnings?.join('\n')).toMatch(/recovered selector drift/i)
    expect(JSON.stringify(def.steps)).toBe(original)
    expect(calls.map(call => call.name)).toEqual([
      'browser_click',
      'browser_snapshot',
      'browser_click',
      'browser_read_page',
    ])
  })
})
