import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { registerPatrolClickTargetTool } from '../src/click-target-tools.js'
import type { PatrolRunner } from '../src/runner.js'
import { PatrolStore } from '../src/store.js'
import type { JsonObject } from '../src/types.js'

async function setup(
  dispatch: (name: string, args: JsonObject) => Promise<{ ok: boolean; text: string; value?: any; error?: string }>,
) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-click-target-'))
  const store = new PatrolStore(root)
  await store.init()
  await store.create({
    schemaVersion: '0.2',
    id: 'click-target',
    name: 'Click target test',
    description: 'click target test',
    status: 'draft',
    target: { type: 'browser', url: 'https://example.test' },
    expectedResult: 'done',
    artifacts: [],
    auth: { mode: 'none' },
    schedule: null,
    steps: [],
    metadata: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  })

  const definitions: any[] = []
  const ctx = {
    tools: {
      register(definition: any) {
        definitions.push(definition)
        return () => {}
      },
    },
  } as unknown as Context
  const runner = { dispatch } as unknown as PatrolRunner
  registerPatrolClickTargetTool(ctx, store, runner, { maxSteps: 20 })
  const tool = definitions.find(definition => definition.name === 'patrol_click_target')
  if (!tool) throw new Error('patrol_click_target was not registered')
  const exec = {
    token: Symbol('test'),
    rootCallId: 'root',
    signal: new AbortController().signal,
  } as unknown as ToolRunContext
  return { root, store, tool, exec }
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
            elements: [
              { tag: 'a', role: 'link', text: '首页 我的工作台 统计分析', selector: '#shell' },
              { tag: 'a', role: 'link', text: '我的工作台', selector: '#workbench' },
            ],
          },
        }
      }
      if (name === 'browser_click') return { ok: true, text: 'Clicked #workbench', value: { ok: true } }
      if (name === 'browser_read_page') {
        return {
          ok: true,
          text: '左侧菜单 待办待阅工单',
          value: { ok: true, text: '左侧菜单 待办待阅工单' },
        }
      }
      throw new Error(`unexpected tool ${name}`)
    })

    const result = await tool.execute({
      inspectionId: 'click-target',
      stepName: '点击我的工作台',
      locatorText: '我的工作台',
      expectedText: '待办待阅工单',
    }, exec)

    expect(result).toContain('Executed and recorded step-001')
    expect(calls).toEqual([
      { tool: 'browser_snapshot', args: { maxElements: 500 } },
      { tool: 'browser_click', args: { selector: 'top-frame::#workbench' } },
      { tool: 'browser_read_page', args: {} },
    ])
    const definition = await store.load('click-target')
    expect(definition.steps).toHaveLength(1)
    expect(definition.steps[0]).toMatchObject({
      id: 'step-001',
      tool: 'browser_click',
      arguments: { selector: 'top-frame::#workbench' },
      locator: { text: '我的工作台' },
      expectation: { mode: 'contains', value: '待办待阅工单' },
    })
  })

  it('does not reject an exact custom clickable div when role=button was only a model hint', async () => {
    const calls: Array<{ tool: string; args: JsonObject }> = []
    const { store, tool, exec } = await setup(async (name, args) => {
      calls.push({ tool: name, args })
      if (name === 'browser_snapshot') {
        return {
          ok: true,
          text: 'snapshot',
          value: {
            ok: true,
            elements: [
              { tag: 'div', text: '登录', selector: '#custom-login' },
            ],
          },
        }
      }
      if (name === 'browser_click') return { ok: true, text: 'Clicked custom login', value: { ok: true } }
      if (name === 'browser_read_page') return { ok: true, text: '系统首页', value: { ok: true, text: '系统首页' } }
      throw new Error(`unexpected tool ${name}`)
    })

    const result = await tool.execute({
      inspectionId: 'click-target',
      stepName: '点击登录',
      locatorText: '登录',
      locatorRole: 'button',
      expectedText: '系统首页',
    }, exec)

    expect(result).toContain('Executed and recorded step-001')
    expect(calls).toEqual([
      { tool: 'browser_snapshot', args: { maxElements: 500 } },
      { tool: 'browser_click', args: { selector: 'top-frame::#custom-login' } },
      { tool: 'browser_read_page', args: {} },
    ])
    expect((await store.load('click-target')).steps[0]).toMatchObject({
      arguments: { selector: 'top-frame::#custom-login' },
      locator: { text: '登录' },
    })
  })

  it('requires explicit post-click success text before recording a semantic click', async () => {
    const calls: Array<{ tool: string; args: JsonObject }> = []
    const { store, tool, exec } = await setup(async (name, args) => {
      calls.push({ tool: name, args })
      if (name === 'browser_snapshot') {
        return {
          ok: true,
          text: 'snapshot',
          value: {
            ok: true,
            elements: [{ tag: 'button', role: 'button', text: '登录', selector: '#login' }],
          },
        }
      }
      if (name === 'browser_click') throw new Error('click must not execute without expectedText')
      throw new Error(`unexpected tool ${name}`)
    })

    const result = await tool.execute({
      inspectionId: 'click-target',
      stepName: '点击登录',
      locatorText: '登录',
    }, exec)

    expect(result).toContain('requires expectedText')
    expect(calls).toEqual([])
    expect((await store.load('click-target')).steps).toEqual([])
  })

  it('does not record a semantic click when the expected next task text is missing after click', async () => {
    const calls: Array<{ tool: string; args: JsonObject }> = []
    const { store, tool, exec } = await setup(async (name, args) => {
      calls.push({ tool: name, args })
      if (name === 'browser_snapshot') {
        return {
          ok: true,
          text: 'snapshot',
          value: {
            ok: true,
            elements: [{ tag: 'a', role: 'link', text: '我的工作台', selector: '#workbench' }],
          },
        }
      }
      if (name === 'browser_click') return { ok: true, text: 'Clicked #workbench', value: { ok: true } }
      if (name === 'browser_read_page') {
        return { ok: true, text: '首页 待办 统计', value: { ok: true, text: '首页 待办 统计' } }
      }
      throw new Error(`unexpected tool ${name}`)
    })

    const result = await tool.execute({
      inspectionId: 'click-target',
      stepName: '点击我的工作台',
      locatorText: '我的工作台',
      expectedText: '待办待阅工单',
    }, exec)

    expect(result).toContain('Post-click expectation was not met')
    expect(result).toContain('was NOT recorded')
    expect(calls.slice(0, 2)).toEqual([
      { tool: 'browser_snapshot', args: { maxElements: 500 } },
      { tool: 'browser_click', args: { selector: 'top-frame::#workbench' } },
    ])
    expect(calls.slice(2)).toEqual([
      { tool: 'browser_read_page', args: {} },
      { tool: 'browser_read_page', args: {} },
      { tool: 'browser_read_page', args: {} },
      { tool: 'browser_read_page', args: {} },
    ])
    expect((await store.load('click-target')).steps).toEqual([])
  })

  it('refuses a broad selector that matches multiple visible elements instead of clicking the first one', async () => {
    const calls: Array<{ tool: string; args: JsonObject }> = []
    const { store, tool, exec } = await setup(async (name, args) => {
      calls.push({ tool: name, args })
      if (name === 'browser_count') return { ok: true, text: '3', value: { ok: true, count: 3 } }
      if (name === 'browser_click') throw new Error('browser_click must not be called for ambiguous target')
      throw new Error(`unexpected tool ${name}`)
    })

    const result = await tool.execute({
      inspectionId: 'click-target',
      stepName: '点击菜单',
      selector: 'nav a',
      expectedText: '详情',
    }, exec)

    expect(result).toContain('ambiguous')
    expect(calls).toEqual([{ tool: 'browser_count', args: { selector: 'nav a' } }])
    expect((await store.load('click-target')).steps).toEqual([])
  })

  it('accepts a unique stable selector without semantic hints', async () => {
    const calls: Array<{ tool: string; args: JsonObject }> = []
    const { store, tool, exec } = await setup(async (name, args) => {
      calls.push({ tool: name, args })
      if (name === 'browser_count') return { ok: true, text: '1', value: { ok: true, count: 1 } }
      if (name === 'browser_click') return { ok: true, text: 'Clicked unique selector', value: { ok: true } }
      if (name === 'browser_read_page') return { ok: true, text: '详情页', value: { ok: true, text: '详情页' } }
      throw new Error(`unexpected tool ${name}`)
    })

    const result = await tool.execute({
      inspectionId: 'click-target',
      stepName: '点击详情',
      selector: '#detail-button',
      expectedText: '详情页',
    }, exec)

    expect(result).toContain('Executed and recorded step-001')
    expect(calls).toEqual([
      { tool: 'browser_count', args: { selector: '#detail-button' } },
      { tool: 'browser_click', args: { selector: '#detail-button' } },
      { tool: 'browser_read_page', args: {} },
    ])
    expect((await store.load('click-target')).steps[0]).toMatchObject({
      arguments: { selector: '#detail-button' },
      expectation: { value: '详情页' },
    })
  })

  it('qualifies an unframed exact menu target so browser_click stays in the top document', async () => {
    const calls: Array<{ tool: string; args: JsonObject }> = []
    const { store, tool, exec } = await setup(async (name, args) => {
      calls.push({ tool: name, args })
      if (name === 'browser_snapshot') {
        return {
          ok: true,
          text: 'snapshot',
          value: {
            ok: true,
            elements: [
              { tag: 'a', role: 'link', text: '我的工作台', selector: 'div > ul > li:nth-of-type(5) > a' },
              { tag: 'a', role: 'link', text: '待办', selector: 'frame-url(http%3A%2F%2Fexample.test%2Fworkbench)::a.todo' },
            ],
          },
        }
      }
      if (name === 'browser_click') return { ok: true, text: 'Clicked workbench', value: { ok: true } }
      if (name === 'browser_read_page') return { ok: true, text: '待办待阅工单', value: { ok: true, text: '待办待阅工单' } }
      throw new Error(`unexpected tool ${name}`)
    })

    const result = await tool.execute({
      inspectionId: 'click-target',
      stepName: '点击我的工作台',
      locatorText: '我的工作台',
      expectedText: '待办待阅工单',
    }, exec)

    expect(result).toContain('Executed and recorded')
    expect(calls[1]).toEqual({
      tool: 'browser_click',
      args: { selector: 'top-frame::div > ul > li:nth-of-type(5) > a' },
    })
    expect((await store.load('click-target')).steps[0]).toMatchObject({
      arguments: { selector: 'top-frame::div > ul > li:nth-of-type(5) > a' },
    })
  })

  it('collapses a nested span duplicate onto its real anchor target', async () => {
    const calls: Array<{ tool: string; args: JsonObject }> = []
    const { store, tool, exec } = await setup(async (name, args) => {
      calls.push({ tool: name, args })
      if (name === 'browser_snapshot') {
        return {
          ok: true,
          text: 'snapshot',
          value: {
            ok: true,
            elements: [
              { tag: 'a', role: 'link', text: '我的工作台', selector: '#workbench' },
              { tag: 'span', text: '我的工作台', selector: '#workbench > span' },
            ],
          },
        }
      }
      if (name === 'browser_click') return { ok: true, text: 'clicked anchor', value: { ok: true } }
      if (name === 'browser_read_page') return { ok: true, text: '待办待阅工单', value: { ok: true, text: '待办待阅工单' } }
      throw new Error(`unexpected tool ${name}`)
    })

    const result = await tool.execute({
      inspectionId: 'click-target',
      stepName: '点击我的工作台',
      locatorText: '我的工作台',
      expectedText: '待办待阅工单',
    }, exec)

    expect(result).toContain('Executed and recorded')
    expect(calls[1]).toEqual({ tool: 'browser_click', args: { selector: 'top-frame::#workbench' } })
    expect((await store.load('click-target')).steps[0]).toMatchObject({ arguments: { selector: 'top-frame::#workbench' } })
  })

  it('prefers the same-text action in the content frame over the shell navigation duplicate', async () => {
    const calls: Array<{ tool: string; args: JsonObject }> = []
    const { store, tool, exec } = await setup(async (name, args) => {
      calls.push({ tool: name, args })
      if (name === 'browser_snapshot') {
        return {
          ok: true,
          text: 'snapshot',
          value: {
            ok: true,
            elements: [
              { tag: 'a', role: 'link', text: '待办', selector: 'top-frame::#shell-todo' },
              { tag: 'a', role: 'link', text: '待办', selector: 'frame-url(http%3A%2F%2Fexample.test%2Fworkbench)::#content-todo' },
            ],
          },
        }
      }
      if (name === 'browser_click') return { ok: true, text: 'clicked content', value: { ok: true } }
      if (name === 'browser_read_page') return { ok: true, text: '工单列表', value: { ok: true, text: '工单列表' } }
      throw new Error(`unexpected tool ${name}`)
    })

    const result = await tool.execute({
      inspectionId: 'click-target',
      stepName: '点击待办',
      locatorText: '待办',
      expectedText: '工单列表',
    }, exec)

    expect(result).toContain('Executed and recorded')
    expect(calls[1]).toEqual({
      tool: 'browser_click',
      args: { selector: 'frame-url(http%3A%2F%2Fexample.test%2Fworkbench)::#content-todo' },
    })
    expect((await store.load('click-target')).steps[0]).toMatchObject({
      arguments: { selector: 'frame-url(http%3A%2F%2Fexample.test%2Fworkbench)::#content-todo' },
    })
  })
})
