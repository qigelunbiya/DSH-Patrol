import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { registerPatrolClickTargetTool } from '../src/click-target-tools.js'
import { PatrolStore } from '../src/store.js'
import type { InspectionDefinition, JsonObject } from '../src/types.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function draftDefinition(): InspectionDefinition {
  const now = new Date().toISOString()
  return {
    schemaVersion: '0.2',
    id: 'ant-rdp-click',
    name: 'Ant RDP click',
    description: 'test semantic action specificity',
    status: 'draft',
    target: { type: 'browser', url: 'https://example.test' },
    expectedResult: 'RDP clicked',
    artifacts: [],
    auth: { mode: 'none' },
    schedule: null,
    steps: [],
    metadata: { createdAt: now, updatedAt: now },
  }
}

async function setup(dispatch: (tool: string, args: JsonObject) => Promise<any>) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-click-specificity-'))
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
    token: Symbol('click-specificity-test'),
    rootCallId: 'root',
    signal: new AbortController().signal,
  } as unknown as ToolRunContext
  return { store, tool, exec }
}

describe('semantic action specificity', () => {
  it('persists the concrete Ant table RDP leaf selected atomically from CURRENT page context', async () => {
    const calls: Array<{ tool: string; args: JsonObject }> = []
    const leafSelector = 'frame-url(https%3A%2F%2Fexample.test%2Fhost-ops)::tr[data-row-key="5860_6066_1_RDP_[EMPTY]"] > td:nth-of-type(5) > span > div > span:nth-of-type(1) > span > span:nth-of-type(2)'

    const { store, tool, exec } = await setup(async (name, args) => {
      calls.push({ tool: name, args })
      if (name === 'browser_semantic_click') {
        return {
          ok: true,
          text: 'RDP connection opened atomically',
          value: {
            ok: true,
            selector: leafSelector,
            text: 'RDP',
            role: 'button',
            tag: 'span',
            frameId: 7,
            frameUrl: 'https://example.test/host-ops',
            transport: 'atomic-main-world-semantic-click',
          },
        }
      }
      if (name === 'browser_read_page') {
        return { ok: true, text: 'RDP connection opened', value: { ok: true, text: 'RDP connection opened' } }
      }
      throw new Error(`unexpected tool ${name}`)
    })

    const result = await tool.execute({
      inspectionId: 'ant-rdp-click',
      stepName: '点击 10.192.3.174 这台运维机的 RDP',
      locatorText: 'RDP',
      expectedText: 'connection opened',
    }, exec)

    expect(result).toContain(leafSelector)
    expect(calls[0]).toEqual({
      tool: 'browser_semantic_click',
      args: {
        locatorText: 'RDP',
        task: '点击 10.192.3.174 这台运维机的 RDP',
      },
    })
    expect(calls[1]).toEqual({ tool: 'browser_read_page', args: {} })
    expect((await store.load('ant-rdp-click')).steps[0]).toMatchObject({
      tool: 'browser_click',
      arguments: { selector: leafSelector },
      locator: { text: 'RDP' },
    })
  })

  it('does not record when the atomic resolver reports two identical RDP targets', async () => {
    const { store, tool, exec } = await setup(async (name) => {
      if (name === 'browser_read_page') {
        return { ok: true, text: '主机运维', value: { ok: true, text: '主机运维' } }
      }
      if (name === 'browser_snapshot') {
        return { ok: true, text: 'snapshot', value: { ok: true, elements: [] } }
      }
      if (name === 'browser_semantic_click') {
        return {
          ok: false,
          text: '',
          error: 'atomic semantic target is ambiguous (2 equally ranked candidates): 0:RDP, 0:RDP',
        }
      }
      throw new Error(`unexpected tool ${name}`)
    })

    const result = await tool.execute({
      inspectionId: 'ant-rdp-click',
      stepName: 'Ambiguous RDP',
      locatorText: 'RDP',
    }, exec)

    expect(result).toMatch(/ambiguous/i)
    expect(result).toContain('NOT recorded')
    expect((await store.load('ant-rdp-click')).steps).toEqual([])
  })
})
