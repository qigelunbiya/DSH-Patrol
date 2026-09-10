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

function atomic(selector: string, text = '') {
  return {
    ok: true,
    text: `Atomically clicked ${selector}`,
    value: {
      ok: true,
      selector,
      text,
      role: 'button',
      tag: 'button',
      transport: 'atomic-main-world-semantic-click',
    },
  }
}

describe('semantic Patrol click target', () => {
  it('dispatches one atomic semantic click instead of snapshot-then-selector click', async () => {
    const calls: Array<{ tool: string; args: JsonObject }> = []
    const { store, tool, exec } = await setup(async (name, args) => {
      calls.push({ tool: name, args })
      if (name === 'browser_semantic_click') return atomic('top-frame::#login', '登 录')
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

    expect(result).toContain('atomic-main-world-semantic-click')
    expect(calls.some(call => call.tool === 'browser_semantic_click')).toBe(true)
    expect(calls.some(call => call.tool === 'browser_click')).toBe(false)
    expect(calls.some(call => call.tool === 'browser_snapshot')).toBe(false)
    expect((await store.load('click-target')).steps[0]).toMatchObject({
      tool: 'browser_click',
      arguments: { selector: 'top-frame::#login' },
      locator: { text: '登录', role: 'button' },
      expectation: { value: '首页' },
      teaching: { status: 'verified', method: 'expected-text' },
    })
  })

  it('clicks a logo atomically without invented expectedText and records only after CURRENT state changes', async () => {
    let clicked = false
    const calls: string[] = []
    const { store, tool, exec } = await setup(async (name) => {
      calls.push(name)
      if (name === 'browser_read_page') return clicked ? page('用户名 密码 短信验证码 登录自助服务平台') : page('长城网际')
      if (name === 'browser_snapshot') {
        return clicked
          ? snapshot([{ tag: 'input', text: '登录自助服务平台', selector: 'top-frame::#sign_in_button_standard' }])
          : snapshot([{ tag: 'a', role: 'link', text: '长城网际', selector: 'top-frame::#logo' }])
      }
      if (name === 'browser_semantic_click') {
        clicked = true
        return atomic('top-frame::#logo', '长城网际')
      }
      throw new Error(`unexpected tool ${name}`)
    })

    const result = await tool.execute({
      inspectionId: 'click-target',
      stepName: '点击 Logo',
      locatorText: '长城网际',
    }, exec)

    expect(result).toContain('automatic CURRENT-state change')
    expect(calls.filter(name => name === 'browser_semantic_click')).toHaveLength(1)
    const saved = await store.load('click-target')
    expect(saved.steps).toHaveLength(1)
    expect(saved.steps[0]).toMatchObject({
      tool: 'browser_click',
      arguments: { selector: 'top-frame::#logo' },
      teaching: { status: 'verified', method: 'state-change' },
    })
  })

  it('passes task context and selector only as a hint to the atomic resolver', async () => {
    const calls: Array<{ tool: string; args: JsonObject }> = []
    const { tool, exec } = await setup(async (name, args) => {
      calls.push({ tool: name, args })
      if (name === 'browser_semantic_click') return atomic('frame-url(https%3A%2F%2Fexample.test%2Fhosts)::button.rdp', 'RDP')
      if (name === 'browser_read_page') return page('主机运维 已打开连接')
      throw new Error(`unexpected tool ${name}`)
    })

    await tool.execute({
      inspectionId: 'click-target',
      stepName: '点击 10.192.3.174 这台主机的 RDP',
      selector: 'button.rdp',
      locatorText: 'RDP',
      expectedText: '已打开连接',
    }, exec)

    const semantic = calls.find(call => call.tool === 'browser_semantic_click')
    expect(semantic?.args).toMatchObject({
      locatorText: 'RDP',
      selectorHint: 'button.rdp',
      task: '点击 10.192.3.174 这台主机的 RDP',
    })
  })

  it('does not persist ephemeral browser tabId values returned during teaching', async () => {
    const { store, tool, exec } = await setup(async (name) => {
      if (name === 'browser_semantic_click') return atomic('top-frame::#workbench', '我的工作台')
      if (name === 'browser_read_page') return page('侧栏 待办待阅工单')
      throw new Error(`unexpected tool ${name}`)
    })

    await tool.execute({
      inspectionId: 'click-target',
      stepName: '点击我的工作台',
      locatorText: '我的工作台',
      locatorRole: 'button',
      expectedText: '待办待阅工单',
      tabId: 1501799722,
    }, exec)

    expect((await store.load('click-target')).steps[0]).toMatchObject({
      arguments: { selector: 'top-frame::#workbench' },
    })
    expect((await store.load('click-target')).steps[0]?.arguments).not.toHaveProperty('tabId')
  })

  it('does not record a semantic click when no observable business state change follows', async () => {
    const { store, tool, exec } = await setup(async (name) => {
      if (name === 'browser_read_page') return page('首页 统计')
      if (name === 'browser_snapshot') return snapshot([{ tag: 'a', role: 'link', text: '我的工作台', selector: 'top-frame::#workbench' }])
      if (name === 'browser_semantic_click') return atomic('top-frame::#workbench', '我的工作台')
      throw new Error(`unexpected tool ${name}`)
    })

    const result = await tool.execute({
      inspectionId: 'click-target',
      stepName: '点击我的工作台',
      locatorText: '我的工作台',
    }, exec)

    expect(result).toContain('NOT recorded')
    expect(result).toContain('no meaningful post-click')
    expect((await store.load('click-target')).steps).toEqual([])
  })

  it('does not record a semantic click when explicit expectedText never appears', async () => {
    const { store, tool, exec } = await setup(async (name) => {
      if (name === 'browser_semantic_click') return atomic('top-frame::#workbench', '我的工作台')
      if (name === 'browser_read_page') return page('首页 统计')
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

  it('keeps selector-only compatibility but refuses ambiguous selectors', async () => {
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

  it('replays the old unique-selector teaching path when no semantic locator is supplied', async () => {
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
