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
      if (name === 'browser_read_page') return { ok: true, text: '登录成功 首页', value: { ok: true, text: '登录成功 首页' } }
      throw new Error(`unexpected tool ${name}`)
    })

    const result = await tool.execute({
      inspectionId: 'click-target',
      stepName: 'Open login',
      locatorText: '登录',
      locatorRole: 'button',
      expectedText: '首页',
    }, exec)

    expect(result).toContain('#top-login')
    expect(calls).toEqual([
      { tool: 'browser_snapshot', args: { maxElements: 500 } },
      { tool: 'browser_click', args: { selector: 'top-frame::#top-login' } },
      { tool: 'browser_read_page', args: {} },
    ])
    const saved = await store.load('click-target')
    expect(saved.steps).toHaveLength(1)
    expect(saved.steps[0]).toMatchObject({
      kind: 'tool',
      tool: 'browser_click',
      arguments: { selector: 'top-frame::#top-login' },
      locator: { text: '登录', role: 'button' },
    })
    expect(saved.steps[0]?.kind === 'tool' ? saved.steps[0].notes : undefined).toContain('执行方法')
    expect(saved.steps[0]?.kind === 'tool' ? saved.steps[0].notes : undefined).toContain('top-frame::#top-login')
    expect(saved.steps[0]?.kind === 'tool' ? saved.steps[0].notes : undefined).toContain('语义目标')
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
            url: 'https://example.test',
            elements: [
              { tag: 'div', text: '登录', selector: '#custom-login' },
              { tag: 'a', role: 'link', text: '登录帮助', selector: '#help' },
            ],
          },
        }
      }
      if (name === 'browser_click') return { ok: true, text: 'Clicked #custom-login', value: { ok: true } }
      if (name === 'browser_read_page') return { ok: true, text: '登录成功 首页', value: { ok: true, text: '登录成功 首页' } }
      throw new Error(`unexpected tool ${name}`)
    })

    const result = await tool.execute({
      inspectionId: 'click-target',
      stepName: 'Open custom login entry',
      locatorText: '登录',
      locatorRole: 'button',
      expectedText: '首页',
    }, exec)

    expect(result).toContain('#custom-login')
    expect(calls).toEqual([
      { tool: 'browser_snapshot', args: { maxElements: 500 } },
      { tool: 'browser_click', args: { selector: 'top-frame::#custom-login' } },
      { tool: 'browser_read_page', args: {} },
    ])
    expect((await store.load('click-target')).steps[0]).toMatchObject({
      tool: 'browser_click',
      arguments: { selector: 'top-frame::#custom-login' },
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
            elements: [{ tag: 'a', role: 'link', text: '我的工作台', selector: '#workbench' }],
          },
        }
      }
      if (name === 'browser_click') return { ok: true, text: 'Clicked #workbench', value: { ok: true } }
      throw new Error(`unexpected tool ${name}`)
    })

    const result = await tool.execute({
      inspectionId: 'click-target',
      stepName: '点击我的工作台',
      locatorText: '我的工作台',
    }, exec)

    expect(result).toContain('was NOT recorded')
    expect(calls).toEqual([
      { tool: 'browser_snapshot', args: { maxElements: 500 } },
      { tool: 'browser_click', args: { selector: 'top-frame::#workbench' } },
    ])
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
    expect(calls).toEqual([
      { tool: 'browser_snapshot', args: { maxElements: 500 } },
      { tool: 'browser_click', args: { selector: 'top-frame::#workbench' } },
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

  it('qualifies an unframed exact menu target so browser_click stays in the top document', async () => {
    const calls: Array<{ tool: string; args: JsonObject }> = []
    const menuSelector = 'div:nth-of-type(1) > div > div > div > ul > li:nth-of-type(5) > a'
    const { store, tool, exec } = await setup(async (name, args) => {
      calls.push({ tool: name, args })
      if (name === 'browser_snapshot') {
        return {
          ok: true,
          text: 'snapshot',
          value: {
            ok: true,
            url: 'http://172.21.9.122/com-portal',
            elements: [
              { tag: 'a', text: '我的工作台', selector: menuSelector },
              { tag: 'a', text: '待办待阅工单', selector: 'frame-url(http%3A%2F%2F172.21.9.122%2Fcmp-cloud-manage%2Fworkbench%2Fhome%2Findex.do)::ul > li:nth-of-type(5) > a' },
            ],
          },
        }
      }
      if (name === 'browser_click') return { ok: true, text: 'clicked top menu', value: { ok: true } }
      if (name === 'browser_read_page') return { ok: true, text: '左侧菜单 待办待阅工单', value: { ok: true, text: '左侧菜单 待办待阅工单' } }
      throw new Error(`unexpected tool ${name}`)
    })

    const result = await tool.execute({
      inspectionId: 'click-target',
      stepName: '点击我的工作台',
      locatorText: '我的工作台',
      expectedText: '待办待阅工单',
    }, exec)

    expect(result).toContain('top-frame::')
    expect(calls).toEqual([
      { tool: 'browser_snapshot', args: { maxElements: 500 } },
      { tool: 'browser_click', args: { selector: `top-frame::${menuSelector}` } },
      { tool: 'browser_read_page', args: {} },
    ])
    expect((await store.load('click-target')).steps[0]).toMatchObject({
      tool: 'browser_click',
      arguments: { selector: `top-frame::${menuSelector}` },
      locator: { text: '我的工作台' },
    })
  })

  it('collapses a nested span duplicate onto its real anchor target', async () => {
    const calls: Array<{ tool: string; args: JsonObject }> = []
    const anchor = 'div:nth-of-type(2) > div:nth-of-type(1) > div > ul > li:nth-of-type(6) > a'
    const nestedSpan = `${anchor} > span`
    const { store, tool, exec } = await setup(async (name, args) => {
      calls.push({ tool: name, args })
      if (name === 'browser_snapshot') {
        return {
          ok: true,
          text: 'snapshot',
          value: {
            ok: true,
            elements: [
              { tag: 'a', role: 'link', text: '待办待阅工单', selector: anchor },
              { tag: 'span', role: 'button', text: '待办待阅工单', selector: nestedSpan },
            ],
          },
        }
      }
      if (name === 'browser_click') return { ok: true, text: `Clicked ${String(args.selector)}`, value: { ok: true } }
      if (name === 'browser_read_page') return { ok: true, text: '待办列表 工单号', value: { ok: true, text: '待办列表 工单号' } }
      throw new Error(`unexpected tool ${name}`)
    })

    const result = await tool.execute({
      inspectionId: 'click-target',
      stepName: '打开待办待阅工单',
      locatorText: '待办待阅工单',
      expectedText: '工单号',
    }, exec)

    expect(result).toContain(anchor)
    expect(calls).toEqual([
      { tool: 'browser_snapshot', args: { maxElements: 500 } },
      { tool: 'browser_click', args: { selector: `top-frame::${anchor}` } },
      { tool: 'browser_read_page', args: {} },
    ])
    expect((await store.load('click-target')).steps[0]).toMatchObject({
      arguments: { selector: `top-frame::${anchor}` },
    })
  })

  it('prefers the same-text action in the content frame over the shell navigation duplicate', async () => {
    const calls: Array<{ tool: string; args: JsonObject }> = []
    const shellSelector = 'div:nth-of-type(2) > div:nth-of-type(1) > div > ul > li:nth-of-type(6) > a'
    const contentSelector = 'frame-url(http%3A%2F%2F172.21.9.122%2Fcmp-cloud-manage%2Fworkbench%2Fhome%2Findex.do)::ul > li:nth-of-type(5) > a'
    const { store, tool, exec } = await setup(async (name, args) => {
      calls.push({ tool: name, args })
      if (name === 'browser_snapshot') {
        return {
          ok: true,
          text: 'snapshot',
          value: {
            ok: true,
            elements: [
              { tag: 'a', role: 'link', text: '待办待阅工单', selector: shellSelector },
              { tag: 'a', role: 'link', text: '待办待阅工单', selector: contentSelector },
            ],
          },
        }
      }
      if (name === 'browser_click') return { ok: true, text: `Clicked ${String(args.selector)}`, value: { ok: true } }
      if (name === 'browser_read_page') return { ok: true, text: '待办列表 工单号', value: { ok: true, text: '待办列表 工单号' } }
      throw new Error(`unexpected tool ${name}`)
    })

    await tool.execute({
      inspectionId: 'click-target',
      stepName: '打开待办待阅工单',
      locatorText: '待办待阅工单',
      expectedText: '工单号',
    }, exec)

    expect(calls).toEqual([
      { tool: 'browser_snapshot', args: { maxElements: 500 } },
      { tool: 'browser_click', args: { selector: contentSelector } },
      { tool: 'browser_read_page', args: {} },
    ])
    expect((await store.load('click-target')).steps[0]).toMatchObject({
      arguments: { selector: contentSelector },
    })
  })
})
