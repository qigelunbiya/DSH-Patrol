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

async function setup(dispatch: (tool: string, args: JsonObject) => Promise<any>) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-click-target-'))
  roots.push(root)
  const store = new PatrolStore(root)
  await store.init()
  await store.create(draftDefinition())

  const definitions: any[] = []
  const ctx = {
    tools: {
      register(definition: any) {
        definitions.push(definition)
        return () => {}
      },
    },
  } as unknown as Context

  registerPatrolClickTargetTool(ctx, store, { dispatch } as any, { maxSteps: 20 })
  const tool = definitions.find(item => item.name === 'patrol_click_target')
  if (!tool) throw new Error('patrol_click_target not registered')
  const exec = {
    token: Symbol('click-target-test'),
    rootCallId: 'root',
    signal: new AbortController().signal,
  } as unknown as ToolRunContext
  return { store, tool, exec }
}

function draftDefinition(): InspectionDefinition {
  const now = new Date().toISOString()
  return {
    schemaVersion: '0.2',
    id: 'click-target',
    name: 'Click target',
    description: 'test',
    status: 'draft',
    target: { type: 'browser', url: 'https://example.test' },
    expectedResult: 'clicked',
    artifacts: [],
    auth: { mode: 'none' },
    schedule: null,
    steps: [],
    metadata: { createdAt: now, updatedAt: now },
  }
}

describe('semantic Patrol click target', () => {
  it('prefers exact visible text over a containing label and records the resolved stable selector', async () => {
    const calls: Array<{ tool: string; args: JsonObject }> = []
    const { store, tool, exec } = await setup(async (name, args) => {
      calls.push({ tool: name, args })
      if (name === 'browser_snapshot') {
        return {
          ok: true,
          text: 'snapshot',
          value: {
            ok: true,
            url: 'https://example.test',
            elements: [
              { tag: 'button', role: 'button', text: '立即登录', selector: '#login-now' },
              { tag: 'button', role: 'button', text: '登录', selector: '#top-login' },
              { tag: 'a', role: 'link', text: '登录', selector: '#login-link' },
            ],
          },
        }
      }
      if (name === 'browser_click') return { ok: true, text: 'Clicked #top-login', value: { ok: true } }
      throw new Error(`unexpected tool ${name}`)
    })

    const result = await tool.execute({
      inspectionId: 'click-target',
      stepName: 'Open login',
      locatorText: '登录',
      locatorRole: 'button',
    }, exec)

    expect(result).toContain('#top-login')
    expect(calls).toEqual([
      { tool: 'browser_snapshot', args: { maxElements: 500 } },
      { tool: 'browser_click', args: { selector: '#top-login' } },
    ])
    const saved = await store.load('click-target')
    expect(saved.steps).toHaveLength(1)
    expect(saved.steps[0]).toMatchObject({
      kind: 'tool',
      tool: 'browser_click',
      arguments: { selector: '#top-login' },
      locator: { text: '登录', role: 'button' },
    })
  })

  it('refuses a broad selector that matches multiple visible elements instead of clicking the first one', async () => {
    const calls: Array<{ tool: string; args: JsonObject }> = []
    const { store, tool, exec } = await setup(async (name, args) => {
      calls.push({ tool: name, args })
      if (name === 'browser_count') return { ok: true, text: '3', value: { ok: true, count: 3 } }
      if (name === 'browser_click') throw new Error('browser_click must not be called for ambiguous target')
      throw new Error(`unexpected tool ${name}`)
    })

    await expect(tool.execute({
      inspectionId: 'click-target',
      stepName: 'Guess a button',
      selector: 'button',
    }, exec)).rejects.toThrow(/ambiguous click selector/i)

    expect(calls).toEqual([{ tool: 'browser_count', args: { selector: 'button', visibleOnly: true } }])
    expect((await store.load('click-target')).steps).toEqual([])
  })

  it('accepts a unique stable selector without semantic hints', async () => {
    const calls: Array<{ tool: string; args: JsonObject }> = []
    const { store, tool, exec } = await setup(async (name, args) => {
      calls.push({ tool: name, args })
      if (name === 'browser_count') return { ok: true, text: '1', value: { ok: true, count: 1 } }
      if (name === 'browser_click') return { ok: true, text: 'clicked', value: { ok: true } }
      throw new Error(`unexpected tool ${name}`)
    })

    await tool.execute({
      inspectionId: 'click-target',
      stepName: 'Click stable login tab',
      selector: '#sms-login-tab',
    }, exec)

    expect(calls).toEqual([
      { tool: 'browser_count', args: { selector: '#sms-login-tab', visibleOnly: true } },
      { tool: 'browser_click', args: { selector: '#sms-login-tab' } },
    ])
    const saved = await store.load('click-target')
    expect(saved.steps[0]).toMatchObject({ tool: 'browser_click', arguments: { selector: '#sms-login-tab' } })
  })
})
