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
  it('prefers the concrete Ant table RDP leaf over page-sized ancestors containing the same text', async () => {
    const calls: Array<{ tool: string; args: JsonObject }> = []
    const leafSelector = 'tr[data-row-key="5860_6066_1_RDP_[EMPTY]"] > td:nth-of-type(5) > span > div > span:nth-of-type(1) > span > span:nth-of-type(2)'
    const pageText = '运维 / 主机运维 返回上一页 控制板 工单 运维 主机运维 共享网盘 任务编排 运维报表 使用本地客户端进行RDP运维时请确认设置 方泽铭运维机 10.192.3.174 Windows [RDP] [EMPTY] 共1条'

    const { store, tool, exec } = await setup(async (name, args) => {
      calls.push({ tool: name, args })
      if (name === 'browser_snapshot') {
        return {
          ok: true,
          text: 'snapshot',
          value: {
            ok: true,
            url: 'https://example.test/host-ops',
            elements: [
              { tag: 'div', role: 'button', text: pageText, selector: '#root' },
              { tag: 'div', role: 'button', text: pageText.slice(20), selector: '#scroll_box' },
              { tag: 'div', role: 'button', text: '方泽铭运维机 10.192.3.174 Windows [RDP] [EMPTY]', selector: 'section > div > div:nth-of-type(2)' },
              { tag: 'span', role: 'button', text: '[RDP] [EMPTY]', selector: leafSelector },
            ],
          },
        }
      }
      if (name === 'browser_click') {
        return { ok: true, text: `Clicked ${String(args.selector)}`, value: { ok: true } }
      }
      throw new Error(`unexpected tool ${name}`)
    })

    const result = await tool.execute({
      inspectionId: 'ant-rdp-click',
      stepName: 'Open RDP access',
      locatorText: 'RDP',
    }, exec)

    expect(result).toContain(leafSelector)
    expect(calls).toEqual([
      { tool: 'browser_snapshot', args: { maxElements: 500 } },
      { tool: 'browser_click', args: { selector: leafSelector } },
    ])
    expect((await store.load('ant-rdp-click')).steps[0]).toMatchObject({
      tool: 'browser_click',
      arguments: { selector: leafSelector },
      locator: { text: 'RDP' },
    })
  })

  it('still refuses two identical exact RDP labels instead of silently choosing a row', async () => {
    const { tool, exec } = await setup(async (name) => {
      if (name === 'browser_snapshot') {
        return {
          ok: true,
          text: 'snapshot',
          value: {
            ok: true,
            elements: [
              { tag: 'span', role: 'button', text: 'RDP', selector: '#row-one-rdp' },
              { tag: 'span', role: 'button', text: 'RDP', selector: '#row-two-rdp' },
            ],
          },
        }
      }
      throw new Error(`unexpected tool ${name}`)
    })

    await expect(tool.execute({
      inspectionId: 'ant-rdp-click',
      stepName: 'Ambiguous RDP',
      locatorText: 'RDP',
    }, exec)).rejects.toThrow(/ambiguous semantic click target/i)
  })
})
