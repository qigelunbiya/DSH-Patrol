import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { registerPatrolDesktopActionTools } from '../src/desktop-action-tools.js'
import { PatrolStore } from '../src/store.js'
import type { InspectionDefinition } from '../src/types.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-desktop-actions-'))
  roots.push(root)
  const store = new PatrolStore(root)
  await store.init()
  const now = '2026-09-18T05:00:00.000Z'
  const definition: InspectionDefinition = {
    schemaVersion: '0.2',
    id: 'wechat-semantic-wait',
    name: '微信语义等待',
    description: 'wait for desktop target',
    status: 'draft',
    target: { type: 'desktop', app: '微信', processName: 'WeChat' },
    expectedResult: '联系人出现',
    artifacts: [],
    auth: { mode: 'none' },
    schedule: null,
    steps: [],
    metadata: {
      createdAt: now,
      updatedAt: now,
      taskChecklist: ['等待测试联系人出现', '在微信消息输入区输入测试消息'],
    },
  }
  await store.create(definition)

  const definitions: any[] = []
  const dispatched: Array<{ tool: string; args: Record<string, unknown> }> = []
  const ctx = {
    tools: {
      register(tool: any) {
        definitions.push(tool)
        return () => {}
      },
    },
  } as unknown as Context
  const runner = {
    async dispatch(tool: string, args: Record<string, unknown>) {
      dispatched.push({ tool, args })
      return { ok: true, text: 'target ready', value: { ok: true, method: 'uia', matchCount: 1 } }
    },
  } as any

  registerPatrolDesktopActionTools(ctx, store, runner, { maxSteps: 20 })
  const action = definitions.find(item => item.name === 'patrol_desktop_action')
  const record = definitions.find(item => item.name === 'patrol_record_desktop_step')
  if (!action) throw new Error('patrol_desktop_action not registered')
  if (!record) throw new Error('patrol_record_desktop_step not registered')
  const exec = {
    token: Symbol('desktop-action'),
    rootCallId: 'root',
    signal: new AbortController().signal,
  } as unknown as ToolRunContext
  return { store, action, record, exec, dispatched }
}

describe('recordable desktop actions', () => {
  it('retrospectively records an already-successful raw desktop action without executing it twice', async () => {
    const { store, record, exec, dispatched } = await setup()
    const output = await record.execute({
      inspectionId: 'wechat-semantic-wait',
      stepName: '打开蓝信中的方泽铭会话',
      action: 'click-ocr-text',
      storedArguments: {
        processName: 'LxMainNew',
        titleContains: '蓝信',
        text: '方泽铭',
        match: 'exact',
        frameId: 'ephemeral-must-not-persist',
      },
      executionInstruction: '激活蓝信窗口，在搜索结果中定位“方泽铭”联系人并点击，确认右侧聊天标题切换为方泽铭。',
    }, exec)

    expect(output).toContain('without re-executing it')
    expect(dispatched).toEqual([])
    const saved = await store.load('wechat-semantic-wait')
    expect(saved.steps[0]).toMatchObject({
      tool: 'desktop_click_ocr_text',
      executionPlane: 'desktop',
      executionInstruction: '激活蓝信窗口，在搜索结果中定位“方泽铭”联系人并点击，确认右侧聊天标题切换为方泽铭。',
      arguments: {
        processName: 'LxMainNew',
        titleContains: '蓝信',
        text: '方泽铭',
        match: 'exact',
      },
    })
    expect(saved.steps[0]?.kind === 'tool' ? saved.steps[0].arguments : {}).not.toHaveProperty('frameId')
  })

  it('executes and persists semantic wait-for-target parameters without coordinates', async () => {
    const { store, action, exec, dispatched } = await setup()

    const output = await action.execute({
      inspectionId: 'wechat-semantic-wait',
      stepName: '等待测试联系人出现',
      action: 'wait-for-target',
      source: 'auto',
      processName: 'WeChat',
      text: '测试联系人',
      match: 'exact',
      requireUnique: true,
      timeoutMs: 10000,
      pollMs: 300,
      languages: ['zh-CN', 'en-US'],
    }, exec)

    expect(output).toContain('Executed and recorded step-001 (desktop_wait_for_target)')
    expect(dispatched).toEqual([{
      tool: 'desktop_wait_for_target',
      args: {
        source: 'auto',
        processName: 'WeChat',
        text: '测试联系人',
        match: 'exact',
        requireUnique: true,
        languages: ['zh-CN', 'en-US'],
        timeoutMs: 10000,
        pollMs: 300,
      },
    }])

    const saved = await store.load('wechat-semantic-wait')
    expect(saved.steps[0]).toMatchObject({
      id: 'step-001',
      name: '等待测试联系人出现',
      tool: 'desktop_wait_for_target',
      arguments: {
        source: 'auto',
        processName: 'WeChat',
        text: '测试联系人',
        match: 'exact',
        requireUnique: true,
        languages: ['zh-CN', 'en-US'],
        timeoutMs: 10000,
        pollMs: 300,
      },
    })
    const args = saved.steps[0]?.kind === 'tool' ? saved.steps[0].arguments : {}
    expect(args).not.toHaveProperty('x')
    expect(args).not.toHaveProperty('y')
    expect(args).not.toHaveProperty('hwnd')
    expect(args).not.toHaveProperty('processId')
  })

  it('records a generic friendly-name application launch without guessing an executable path', async () => {
    const { store, action, exec, dispatched } = await setup()

    const output = await action.execute({
      inspectionId: 'wechat-semantic-wait',
      stepName: '启动桌面应用',
      action: 'launch-app',
      app: 'Some Installed App',
    }, exec)

    expect(output).toContain('Executed and recorded step-001 (desktop_launch_app)')
    expect(dispatched).toEqual([{
      tool: 'desktop_launch_app',
      args: { app: 'Some Installed App' },
    }])
    const saved = await store.load('wechat-semantic-wait')
    expect(saved.steps[0]).toMatchObject({
      tool: 'desktop_launch_app',
      arguments: { app: 'Some Installed App' },
    })
    expect(saved.steps[0]?.kind === 'tool' ? saved.steps[0].arguments : {}).not.toHaveProperty('file')
  })

  it('executes and persists targeted desktop typing by stable UIA selector', async () => {
    const { store, action, exec, dispatched } = await setup()

    const output = await action.execute({
      inspectionId: 'wechat-semantic-wait',
      stepName: '在消息输入区输入测试消息',
      action: 'type-target',
      processName: 'WeChat',
      controlType: 'Edit',
      className: 'MessageInput',
      text: 'DSH Patrol Desktop Automation 测试',
      clear: true,
    }, exec)

    expect(output).toContain('Executed and recorded step-001 (desktop_type_target)')
    expect(dispatched).toEqual([{
      tool: 'desktop_type_target',
      args: {
        processName: 'WeChat',
        controlType: 'Edit',
        className: 'MessageInput',
        text: 'DSH Patrol Desktop Automation 测试',
        clear: true,
      },
    }])

    const saved = await store.load('wechat-semantic-wait')
    expect(saved.steps[0]).toMatchObject({
      id: 'step-001',
      name: '在消息输入区输入测试消息',
      tool: 'desktop_type_target',
      arguments: {
        processName: 'WeChat',
        controlType: 'Edit',
        className: 'MessageInput',
        text: 'DSH Patrol Desktop Automation 测试',
        clear: true,
      },
    })
    const args = saved.steps[0]?.kind === 'tool' ? saved.steps[0].arguments : {}
    expect(args).not.toHaveProperty('x')
    expect(args).not.toHaveProperty('y')
    expect(args).not.toHaveProperty('hwnd')
    expect(args).not.toHaveProperty('processId')
  })

  it('persists a safe UIA value selector for semantic verification waits', async () => {
    const { store, action, exec, dispatched } = await setup()

    await action.execute({
      inspectionId: 'wechat-semantic-wait',
      stepName: '等待输入区包含测试消息',
      action: 'wait-for-target',
      source: 'uia',
      processName: 'WeChat',
      controlType: 'Edit',
      className: 'MessageInput',
      value: 'DSH Patrol',
      match: 'contains',
      requireUnique: true,
      timeoutMs: 5000,
    }, exec)

    expect(dispatched[0]).toEqual({
      tool: 'desktop_wait_for_target',
      args: {
        source: 'uia',
        processName: 'WeChat',
        controlType: 'Edit',
        className: 'MessageInput',
        value: 'DSH Patrol',
        match: 'contains',
        requireUnique: true,
        timeoutMs: 5000,
      },
    })
    const saved = await store.load('wechat-semantic-wait')
    expect(saved.steps[0]).toMatchObject({
      tool: 'desktop_wait_for_target',
      arguments: {
        source: 'uia',
        controlType: 'Edit',
        className: 'MessageInput',
        value: 'DSH Patrol',
      },
    })
  })

  it('persists stable target-window selectors for focus-relative keyboard and paste actions', async () => {
    const { store, action, exec, dispatched } = await setup()

    await action.execute({
      inspectionId: 'wechat-semantic-wait',
      stepName: '打开微信搜索',
      action: 'hotkey',
      processName: 'WeChat',
      titleContains: '微信',
      combo: 'Ctrl+F',
    }, exec)
    await action.execute({
      inspectionId: 'wechat-semantic-wait',
      stepName: '输入搜索词',
      action: 'type-text',
      processName: 'WeChat',
      titleContains: '微信',
      text: '测试联系人',
      clear: true,
    }, exec)
    await action.execute({
      inspectionId: 'wechat-semantic-wait',
      stepName: '粘贴剪贴板',
      action: 'paste',
      processName: 'WeChat',
      titleContains: '微信',
    }, exec)
    await action.execute({
      inspectionId: 'wechat-semantic-wait',
      stepName: '确认发送',
      action: 'press',
      processName: 'WeChat',
      titleContains: '微信',
      key: 'Enter',
    }, exec)

    expect(dispatched.map(item => item.tool)).toEqual([
      'desktop_hotkey',
      'desktop_type_text',
      'desktop_paste',
      'desktop_press',
    ])
    for (const item of dispatched) {
      expect(item.args).toMatchObject({
        processName: 'WeChat',
        titleContains: '微信',
      })
    }

    const saved = await store.load('wechat-semantic-wait')
    expect(saved.steps.map(step => step.kind === 'tool' ? [step.tool, step.arguments] : [])).toEqual([
      ['desktop_hotkey', { processName: 'WeChat', titleContains: '微信', combo: 'Ctrl+F' }],
      ['desktop_type_text', { processName: 'WeChat', titleContains: '微信', text: '测试联系人', clear: true }],
      ['desktop_paste', { processName: 'WeChat', titleContains: '微信' }],
      ['desktop_press', { processName: 'WeChat', titleContains: '微信', key: 'Enter' }],
    ])
  })

  it('inherits the desktop inspection target and records atomic paste/key actions for one UIA control', async () => {
    const { store, action, exec, dispatched } = await setup()

    await action.execute({
      inspectionId: 'wechat-semantic-wait',
      stepName: '粘贴截图到消息输入区',
      action: 'paste-target',
      controlType: 'Edit',
      className: 'MessageInput',
    }, exec)
    await action.execute({
      inspectionId: 'wechat-semantic-wait',
      stepName: '在消息输入区按回车',
      action: 'press-target',
      controlType: 'Edit',
      className: 'MessageInput',
      key: 'Enter',
    }, exec)

    expect(dispatched).toEqual([
      {
        tool: 'desktop_paste_target',
        args: {
          processName: 'WeChat',
          controlType: 'Edit',
          className: 'MessageInput',
        },
      },
      {
        tool: 'desktop_press_target',
        args: {
          processName: 'WeChat',
          controlType: 'Edit',
          className: 'MessageInput',
          key: 'Enter',
        },
      },
    ])

    const saved = await store.load('wechat-semantic-wait')
    expect(saved.steps.map(step => step.kind === 'tool' ? [step.tool, step.arguments] : [])).toEqual([
      ['desktop_paste_target', {
        processName: 'WeChat',
        controlType: 'Edit',
        className: 'MessageInput',
      }],
      ['desktop_press_target', {
        processName: 'WeChat',
        controlType: 'Edit',
        className: 'MessageInput',
        key: 'Enter',
      }],
    ])
  })

  it('rejects invalid wait bounds before dispatching or recording', async () => {
    const { store, action, exec, dispatched } = await setup()

    await expect(action.execute({
      inspectionId: 'wechat-semantic-wait',
      stepName: '错误等待',
      action: 'wait-for-target',
      text: '测试联系人',
      timeoutMs: 50,
    }, exec)).rejects.toThrow(/timeoutMs must be between 100 and 120000/i)

    expect(dispatched).toEqual([])
    expect((await store.load('wechat-semantic-wait')).steps).toEqual([])
  })
})
