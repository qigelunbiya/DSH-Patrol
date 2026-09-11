import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { registerPatrolClickTargetTool } from '../src/click-target-tools.ts'
import { PatrolStore } from '../src/store.ts'
import type { InspectionDefinition, JsonObject } from '../src/types.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function draft(): InspectionDefinition {
  const now = new Date().toISOString()
  return {
    schemaVersion: '0.2',
    id: 'actionability',
    name: 'Actionability regression',
    description: 'test',
    status: 'draft',
    target: { type: 'browser', url: 'https://example.test' },
    expectedResult: 'menu opened',
    artifacts: [],
    auth: { mode: 'none' },
    schedule: null,
    steps: [],
    metadata: { createdAt: now, updatedAt: now, taskChecklist: ['点击目标'] },
  }
}

describe('semantic click actionability', () => {
  it('records the actionable leaf returned by the atomic MAIN-world resolver', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-actionability-'))
    roots.push(root)
    const store = new PatrolStore(root)
    await store.init()
    await store.create(draft())

    const registered: any[] = []
    const ctx = {
      tools: {
        register(tool: any) {
          registered.push(tool)
          return () => {}
        },
      },
    } as unknown as Context

    const calls: Array<{ tool: string; args: JsonObject }> = []
    const runner = {
      async dispatch(tool: string, args: JsonObject) {
        calls.push({ tool, args })
        if (tool === 'browser_semantic_click') {
          return {
            ok: true,
            text: 'clicked actionable anchor atomically',
            value: {
              ok: true,
              selector: 'top-frame::#nav-workbench > a',
              text: '我的工作台',
              role: 'link',
              tag: 'a',
              transport: 'atomic-main-world-semantic-click',
            },
          }
        }
        if (tool === 'browser_read_page') return { ok: true, text: '侧栏 待办待阅工单', value: { ok: true, text: '侧栏 待办待阅工单' } }
        throw new Error(`unexpected tool ${tool}`)
      },
    }

    registerPatrolClickTargetTool(ctx, store, runner as any, { maxSteps: 20 })
    const tool = registered.find(item => item.name === 'patrol_click_target')
    const exec = {
      token: Symbol('actionability'),
      rootCallId: 'root',
      signal: new AbortController().signal,
    } as unknown as ToolRunContext

    await tool.execute({
      inspectionId: 'actionability',
      stepName: '点击我的工作台',
      locatorText: '我的工作台',
      expectedText: '待办待阅工单',
    }, exec)

    expect(calls).toEqual([
      {
        tool: 'browser_semantic_click',
        args: { locatorText: '我的工作台', task: '点击我的工作台' },
      },
      { tool: 'browser_read_page', args: {} },
    ])
    expect((await store.load('actionability')).steps[0]).toMatchObject({
      tool: 'browser_click',
      arguments: { selector: 'top-frame::#nav-workbench > a' },
      locator: { text: '我的工作台' },
      teaching: { status: 'verified', method: 'expected-text' },
    })
  })
})
