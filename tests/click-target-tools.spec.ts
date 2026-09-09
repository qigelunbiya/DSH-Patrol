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

function snapshot(elements: any[], url = 'https://example.test') {
  return { ok: true, text: 'snapshot', value: { ok: true, url, elements } }
}

function page(text: string, url = 'https://example.test') {
  return { ok: true, text, value: { ok: true, url, text } }
}

describe('semantic Patrol click target', () => {
  it('prefers an exact actionable control and verifies a known post-click state', async () => {
    const calls: Array<{ tool: string; args: JsonObject }> = []
    const { store, tool, exec } = await setup(async (name, args) => {
      calls.push({ tool: name, args })
      if (name === 'browser_snapshot') return snapshot([
        { tag: 'button', role: 'button', text: '立即登录', selector: '#login-now' },
        { tag: 'button', role: 'button', text: '登录', selector: '#top-login' },
        { tag: 'a', role: 'link', text: '登录', selector: '#login-link' },
      ])
      if (name === 'browser_click') return { ok: true, text: 'clicked', value: { ok: true } }
      if (name === 'browser_read_page') return page('登录成功 首页')
      throw new Error(`unexpected tool ${name}`)
    })

    const result = await tool.execute({
      inspectionId: 'click-target',
      stepName: '点击登录',
      locatorText: '登录',
      locatorRole: 'button',
      expectedText: '首页',
    }, exec)

    expect(result).toContain('top-frame::#top-login')
    expect(calls[0]).toEqual({ tool: 'browser_snapshot', args: { maxElements: 500, includeHidden: false } })
    expect(calls.some(call => call.tool === 'browser_click' && call.args.selector === 'top-frame::#top-login')).toBe(true)
    expect((await store.load('click-target')).steps[0]).toMatchObject({
      tool: 'browser_click',
      arguments: { selector: 'top-frame::#top-login' },
      locator: { text: '登录', role: 'button' },
      expectation: { value: '首页' },
      teaching: { status: 'verified', method: 'expected-text' },
    })
  })

  it('clicks a logo without invented expectedText and records it after CURRENT state changes', async () => {
    let clicked = false
    const { store, tool, exec } = await setup(async (name) => {
      if (name === 'browser_snapshot') {
        return clicked
          ? snapshot([
              { tag: 'input', text: '登录自助服务平台', selector: '#sign_in_button_standard' },
              { tag: 'input', selector: '#username' },
            ])
          : snapshot([{ tag: 'a', role: 'link', text: '长城网际', selector: '#logo' }])
      }
      if (name === 'browser_read_page') return clicked ? page('用户名 密码 短信验证码 登录自助服务平台') : page('长城网际')
      if (name === 'browser_click') {
        clicked = true
        return { ok: true, text: 'clicked logo', value: { ok: true } }
      }
      throw new Error(`unexpected tool ${name}`)
    })

    const result = await tool.execute({
      inspectionId: 'click-target',
      stepName: '点击 Logo',
      locatorText: '长城网际',
    }, exec)

    expect(result).toContain('automatic CURRENT-state change')
    const saved = await store.load('click-target')
    expect(saved.steps).toHaveLength(1)
    expect(saved.steps[0]).toMatchObject({
      tool: 'browser_click',
      arguments: { selector: 'top-frame::#logo' },
      teaching: { status: 'verified', method: 'state-change' },
    })
  })

  it('does not record an unknown-state semantic click when nothing observable changes', async () => {
    const { store, tool, exec } = await setup(async (name) => {
      if (name === 'browser_snapshot') return snapshot([{ tag: 'a', role: 'link', text: '我的工作台', selector: '#workbench' }])
      if (name === 'browser_read_page') return page('首页 统计')
      if (name === 'browser_click') return { ok: true, text: 'clicked', value: { ok: true } }
      throw new Error(`unexpected tool ${name}`)
    })

    const result = await tool.execute({
      inspectionId: 'click-target',
      stepName: '点击我的工作台',
      locatorText: '我的工作台',
    }, exec)

    expect(result).toContain('no meaningful post-click')
    expect(result).toContain('NOT recorded')
    expect((await store.load('click-target')).steps).toEqual([])
  })

  it('does not record a click when explicit expectedText never appears', async () => {
    const { store, tool, exec } = await setup(async (name) => {
      if (name === 'browser_snapshot') return snapshot([{ tag: 'a', role: 'link', text: '我的工作台', selector: '#workbench' }])
      if (name === 'browser_click') return { ok: true, text: 'clicked', value: { ok: true } }
      if (name === 'browser_read_page') return page('首页 待办 统计')
      throw new Error(`unexpected tool ${name}`)
    })

    const result = await tool.execute({
      inspectionId: 'click-target',
      stepName: '点击我的工作台',
      locatorText: '我的工作台',
      expectedText: '待办待阅工单',
    }, exec)

    expect(result).toContain('Post-click expectation was not met')
    expect((await store.load('click-target')).steps).toEqual([])
  })

  it('refuses a broad selector that matches multiple visible elements', async () => {
    const calls: Array<{ tool: string; args: JsonObject }> = []
    const { store, tool, exec } = await setup(async (name, args) => {
      calls.push({ tool: name, args })
      if (name === 'browser_count') return { ok: true, text: '3', value: { ok: true, count: 3 } }
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

  it('qualifies a CURRENT top-menu element so identical iframe CSS cannot steal the click', async () => {
    const menuSelector = '#header-mainnav > li[menuid="119ff592-fc13-4f7a-bb02-5e34241901a6"] > a'
    const { store, tool, exec } = await setup(async (name, args) => {
      if (name === 'browser_snapshot') return snapshot([
        { tag: 'a', role: 'link', text: '我的工作台', selector: menuSelector },
        { tag: 'a', role: 'link', text: '待办待阅工单', selector: 'frame-url(https%3A%2F%2Fexample.test%2Fframe)::a' },
      ])
      if (name === 'browser_click') {
        expect(args.selector).toBe(`top-frame::${menuSelector}`)
        return { ok: true, text: 'clicked top menu', value: { ok: true } }
      }
      if (name === 'browser_read_page') return page('首页 左侧菜单 待办待阅工单')
      throw new Error(`unexpected tool ${name}`)
    })

    await tool.execute({
      inspectionId: 'click-target',
      stepName: '点击我的工作台',
      locatorText: '我的工作台',
      expectedText: '待办待阅工单',
    }, exec)

    expect((await store.load('click-target')).steps[0]).toMatchObject({
      arguments: { selector: `top-frame::${menuSelector}` },
      locator: { text: '我的工作台' },
    })
  })

  it('accepts a unique stable selector without semantic hints', async () => {
    const { store, tool, exec } = await setup(async (name) => {
      if (name === 'browser_count') return { ok: true, text: '1', value: { ok: true, count: 1 } }
      if (name === 'browser_click') return { ok: true, text: 'clicked', value: { ok: true } }
      throw new Error(`unexpected tool ${name}`)
    })

    await tool.execute({
      inspectionId: 'click-target',
      stepName: 'Click stable tab',
      selector: '#sms-login-tab',
    }, exec)

    expect((await store.load('click-target')).steps[0]).toMatchObject({
      tool: 'browser_click',
      arguments: { selector: '#sms-login-tab' },
    })
  })
})
