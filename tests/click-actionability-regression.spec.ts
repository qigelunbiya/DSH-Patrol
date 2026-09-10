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
    metadata: { createdAt: now, updatedAt: now },
  }
}

describe('semantic click actionability', () => {
  it('clicks the actionable anchor instead of an outer layout node with the same text', async () => {
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
        if (tool === 'browser_snapshot') {
          return {
            ok: true,
            text: 'snapshot',
            value: {
              ok: true,
              elements: [
                { tag: 'li', text: '我的工作台', selector: '#nav-workbench' },
                { tag: 'a', role: 'link', text: '我的工作台', selector: '#nav-workbench > a' },
              ],
            },
          }
        }
        if (tool === 'browser_click') return { ok: true, text: 'clicked actionable anchor', value: { ok: true } }
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
      { tool: 'browser_snapshot', args: { maxElements: 500, includeHidden: false } },
      { tool: 'browser_click', args: { selector: 'top-frame::#nav-workbench > a' } },
      { tool: 'browser_read_page', args: {} },
    ])
    expect((await store.load('actionability')).steps[0]).toMatchObject({
      tool: 'browser_click',
      arguments: { selector: 'top-frame::#nav-workbench > a' },
      locator: { text: '我的工作台' },
    })
  })
})