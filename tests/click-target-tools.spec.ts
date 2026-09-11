import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { registerPatrolClickTargetTool } from '../src/click-target-tools.ts'
import { createPatrolClickOutcomeTracker } from '../src/click-retry-state.ts'
import { PatrolStore } from '../src/store.ts'
import type { InspectionDefinition, JsonObject } from '../src/types.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function setup(
  dispatch: (tool: string, args: JsonObject) => Promise<any>,
  clickOutcomes: ReturnType<typeof createPatrolClickOutcomeTracker> | undefined = undefined,
) {
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

  registerPatrolClickTargetTool(ctx, store, { dispatch } as any, { maxSteps: 20, clickOutcomes })
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
    metadata: { createdAt: now, updatedAt: now, taskChecklist: ['点击目标'] },
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
  it('refuses before browser dispatch when the DRAFT has no persisted checklist', async () => {
    const calls: string[] = []
    const { store, tool, exec } = await setup(async (name) => { calls.push(name); throw new Error(`unexpected ${name}`) })
    const definition = await store.load('click-target')
    delete definition.metadata.taskChecklist
    await store.save(definition)

    await expect(tool.execute({
      inspectionId: 'click-target', stepName: '点击登录', locatorText: '登录',
    }, exec)).rejects.toThrow(/persisted task checklist/i)
    expect(calls).toEqual([])
  })

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

  it('falls back to a unique CURRENT selector when atomic semantic click is unavailable', async () => {
    let clicked = false
    const calls: string[] = []
    const { store, tool, exec } = await setup(async (name) => {
      calls.push(name)
      if (name === 'browser_semantic_click') return { ok: false, text: '', error: 'semantic click transport unavailable' }
      if (name === 'browser_snapshot') {
        return clicked
          ? snapshot([{ tag: 'input', text: '登录', selector: 'top-frame::#sign_in_button_standard' }])
          : snapshot([{ tag: 'a', role: 'link', text: '长城网际', selector: 'top-frame::#logo' }])
      }
      if (name === 'browser_count') return { ok: true, text: '1', value: { ok: true, count: 1 } }
      if (name === 'browser_click') {
        clicked = true
        return { ok: true, text: 'Clicked logo', value: { ok: true, selector: '#logo' } }
      }
      if (name === 'browser_read_page') return page(clicked ? '用户名 密码 短信验证码 登录' : '长城网际')
      throw new Error(`unexpected tool ${name}`)
    })

    const result = await tool.execute({
      inspectionId: 'click-target',
      stepName: '点击 Logo',
      selector: 'top-frame::#logo',
      locatorText: '长城网际',
    }, exec)

    expect(result).toContain('selector-compatible fallback')
    expect(calls).toContain('browser_semantic_click')
    expect(calls).toContain('browser_snapshot')
    expect(calls).toContain('browser_count')
    expect(calls).toContain('browser_click')
    expect((await store.load('click-target')).steps[0]).toMatchObject({
      tool: 'browser_click',
      arguments: { selector: 'top-frame::#logo' },
      locator: { text: '长城网际' },
      teaching: { status: 'verified', method: 'state-change' },
    })
  })

  it('accepts a unique CURRENT selector when the requested label is a meaningful substring', async () => {
    let clicked = false
    const { store, tool, exec } = await setup(async (name) => {
      if (name === 'browser_read_page') return page(clicked ? '我的工作台' : '登录自助服务平台')
      if (name === 'browser_semantic_click') return { ok: false, text: '', error: 'unsupported browser command: semanticClick' }
      if (name === 'browser_snapshot') return clicked
        ? snapshot([{ tag: 'a', text: '我的工作台', selector: 'top-frame::#workbench' }])
        : snapshot([{ tag: 'input', role: 'button', text: '登录自助服务平台', selector: 'top-frame::#sign_in_button_standard' }])
      if (name === 'browser_count') return { ok: true, text: '1', value: { ok: true, count: 1 } }
      if (name === 'browser_click') {
        clicked = true
        return { ok: true, text: 'clicked', value: { ok: true } }
      }
      throw new Error(`unexpected tool ${name}`)
    })

    const result = await tool.execute({
      inspectionId: 'click-target',
      stepName: '点击登录',
      selector: 'top-frame::#sign_in_button_standard',
      locatorText: '登录',
      locatorRole: 'button',
    }, exec)

    expect(result).toContain('selector-compatible fallback')
    expect((await store.load('click-target')).steps).toHaveLength(1)
  })

  it('rejects reverse and dangerous semantic substrings even with a unique selector', async () => {
    for (const [requested, observed] of [
      ['登录自助服务平台', '登录'],
      ['确定', '确定删除账户'],
    ]) {
      const calls: string[] = []
      const { store, tool, exec } = await setup(async (name) => {
        calls.push(name)
        if (name === 'browser_read_page') return page(observed)
        if (name === 'browser_semantic_click') return { ok: false, text: '', error: 'transport unavailable' }
        if (name === 'browser_snapshot') return snapshot([{ tag: 'button', role: 'button', text: observed, selector: 'top-frame::#target' }])
        throw new Error(`unexpected tool ${name}`)
      })
      const result = await tool.execute({
        inspectionId: 'click-target', stepName: `点击${requested}`,
        selector: 'top-frame::#target', locatorText: requested, locatorRole: 'button',
      }, exec)
      expect(result).toContain('not uniquely bound')
      expect(calls).not.toContain('browser_click')
      expect((await store.load('click-target')).steps).toEqual([])
    }
  })

  it('keeps semantic fallback fail-closed when the selector hint is ambiguous', async () => {
    const calls: string[] = []
    const { store, tool, exec } = await setup(async (name) => {
      calls.push(name)
      if (name === 'browser_semantic_click') return { ok: false, text: '', error: 'semantic click transport unavailable' }
      if (name === 'browser_snapshot') return snapshot([{ tag: 'a', role: 'link', text: '长城网际', selector: 'top-frame::a' }])
      if (name === 'browser_count') return { ok: true, text: '2', value: { ok: true, count: 2 } }
      if (name === 'browser_read_page') return page('长城网际')
      throw new Error(`unexpected tool ${name}`)
    })

    const result = await tool.execute({
      inspectionId: 'click-target',
      stepName: '点击 Logo',
      selector: 'a',
      locatorText: '长城网际',
    }, exec)

    expect(result).toContain('selector fallback was NOT recorded')
    expect(calls).toEqual(['browser_read_page', 'browser_snapshot', 'browser_semantic_click', 'browser_snapshot'])
    expect((await store.load('click-target')).steps).toEqual([])
  })

  it('rejects a unique but stale selector that is absent from the CURRENT snapshot', async () => {
    const calls: string[] = []
    const { store, tool, exec } = await setup(async (name) => {
      calls.push(name)
      if (name === 'browser_read_page') return page('长城网际')
      if (name === 'browser_semantic_click') return { ok: false, text: '', error: 'semantic click transport unavailable' }
      if (name === 'browser_snapshot') return snapshot([{ tag: 'a', role: 'link', text: '其他入口', selector: 'top-frame::#other' }])
      if (name === 'browser_count') return { ok: true, text: '1', value: { ok: true, count: 1 } }
      throw new Error(`unexpected tool ${name}`)
    })

    const result = await tool.execute({
      inspectionId: 'click-target',
      stepName: '点击 Logo',
      selector: 'top-frame::#logo',
      locatorText: '长城网际',
    }, exec)

    expect(result).toContain('not uniquely bound to the CURRENT snapshot')
    expect(calls).not.toContain('browser_click')
    expect((await store.load('click-target')).steps).toEqual([])
  })

  it('allows a CURRENT selector that disambiguates duplicate semantic text across frames', async () => {
    let clicked = false
    const { store, tool, exec } = await setup(async (name) => {
      if (name === 'browser_read_page') return page(clicked ? '工作台侧栏' : '首页')
      if (name === 'browser_semantic_click') return { ok: false, text: '', error: 'semantic click transport unavailable' }
      if (name === 'browser_snapshot') {
        return clicked
          ? snapshot([{ tag: 'aside', role: 'navigation', text: '工作台侧栏', selector: 'top-frame::#sidebar' }])
          : snapshot([
              { tag: 'a', role: 'link', text: '我的工作台', selector: 'top-frame::#workbench' },
              { tag: 'a', role: 'link', text: '我的工作台', selector: 'frame-url(https%3A%2F%2Fexample.test%2Fembed)::#workbench' },
            ])
      }
      if (name === 'browser_count') return { ok: true, text: '1', value: { ok: true, count: 1 } }
      if (name === 'browser_click') {
        clicked = true
        return { ok: true, text: 'Clicked workbench', value: { ok: true } }
      }
      throw new Error(`unexpected tool ${name}`)
    })

    const result = await tool.execute({
      inspectionId: 'click-target',
      stepName: '点击我的工作台',
      selector: 'top-frame::#workbench',
      locatorText: '我的工作台',
    }, exec)

    expect(result).toContain('selector-compatible fallback')
    expect((await store.load('click-target')).steps[0]).toMatchObject({
      arguments: { selector: 'top-frame::#workbench' },
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

  it('records only an executed-but-unverified physical click in retry state', async () => {
    const outcomes = createPatrolClickOutcomeTracker()
    const input = { inspectionId: 'click-target', stepName: '点击提交', locatorText: '提交' }
    const { tool, exec } = await setup(async (name) => {
      if (name === 'browser_read_page') return page('表单')
      if (name === 'browser_snapshot') return snapshot([{ tag: 'button', role: 'button', text: '提交', selector: 'top-frame::#submit' }])
      if (name === 'browser_semantic_click') return atomic('top-frame::#submit', '提交')
      throw new Error(`unexpected tool ${name}`)
    }, outcomes)

    expect(outcomes.unverifiedPhysicalClicks(input)).toBe(0)
    const result = await tool.execute(input, exec)
    expect(result).toContain('NOT recorded')
    expect(outcomes.unverifiedPhysicalClicks(input)).toBe(1)
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
