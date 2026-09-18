import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { registerPatrolEditTools } from '../src/edit-tools.ts'
import { PatrolLifecycleStore } from '../src/lifecycle-store.ts'
import { PatrolRunner } from '../src/runner.ts'
import { PatrolStore } from '../src/store.ts'
import type { InspectionDefinition } from '../src/types.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function setup(options: { lifecycle?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-edit-'))
  roots.push(root)
  const store = options.lifecycle === true ? new PatrolLifecycleStore(root) : new PatrolStore(root)
  await store.init()
  const definitions: any[] = []
  const ctx = {
    tools: {
      register(definition: any) {
        definitions.push(definition)
        return () => {}
      },
    },
    get(name: string) {
      if (name === 'credentials') {
        return {
          async describe() { return { configured: true, source: 'test' } },
        }
      }
      return undefined
    },
  } as unknown as Context

  let dispatchCalls = 0
  const runner = {
    async dispatch() {
      dispatchCalls += 1
      return { ok: true, text: 'ok', value: { ok: true } }
    },
    async run(definition: InspectionDefinition) {
      return {
        report: {
          schemaVersion: '0.2' as const,
          runId: 'validation-run',
          inspectionId: definition.id,
          inspectionName: definition.name,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          status: 'passed' as const,
          expectedResult: definition.expectedResult,
          results: [],
        },
        paths: {
          directory: join(root, 'runs', definition.id, 'validation-run'),
          json: join(root, 'runs', definition.id, 'validation-run', 'report.json'),
          markdown: join(root, 'runs', definition.id, 'validation-run', 'report.md'),
        },
      }
    },
    async resume(definition: InspectionDefinition) {
      return await this.run(definition)
    },
  } as unknown as PatrolRunner

  registerPatrolEditTools(ctx, store, runner)
  const tool = (name: string) => {
    const found = definitions.find(item => item.name === name)
    if (!found) throw new Error(`tool ${name} not registered`)
    return found
  }
  const exec = {
    token: Symbol('edit-test'),
    rootCallId: 'root',
    signal: new AbortController().signal,
  } as unknown as ToolRunContext
  return { store, tool, exec, dispatchCalls: () => dispatchCalls }
}

function readyDefinition(): InspectionDefinition {
  return {
    schemaVersion: '0.2',
    id: 'editable-login',
    name: 'Editable login',
    description: 'Login editing test',
    status: 'ready',
    target: { type: 'browser', url: 'https://example.com/login' },
    expectedResult: 'logged in',
    artifacts: [],
    auth: { mode: 'secret-ref' },
    schedule: { enabled: true, cron: '0 9 * * 1-5' },
    steps: [
      {
        id: 'step-001',
        kind: 'tool',
        name: 'username',
        tool: 'browser_type',
        arguments: { selector: '#username', text: 'old@example.com', clear: true },
        recordedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'step-002',
        kind: 'tool',
        name: 'password',
        tool: 'browser_type_credential',
        arguments: { selector: '#password', credentialRef: '${credential:OLD_PASSWORD}', clear: true },
        sensitive: true,
        recordedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'step-003',
        kind: 'checkpoint',
        name: 'verification',
        prompt: 'Complete the verification shown in the managed browser.',
        reason: 'other',
        when: {
          sourceStepId: 'step-002',
          mode: 'contains',
          value: 'challenge',
          caseSensitive: false,
        },
        notes: 'old note',
        recordedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    metadata: {
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      validatedAt: '2026-01-01T00:00:00.000Z',
      taskChecklist: ['username', 'password', 'verification'],
    },
  }
}

describe('editable Patrol runbooks', () => {
  it('re-teaches username and credential steps, validates, then returns to READY', async () => {
    const { store, tool, exec } = await setup()
    await store.create(readyDefinition())

    await tool('patrol_begin_edit').execute({ inspectionId: 'editable-login' }, exec)
    let definition = await store.load('editable-login')
    expect(definition.status).toBe('draft')
    expect(definition.metadata.validatedAt).toBeUndefined()
    expect(definition.schedule?.enabled).toBe(true)

    await tool('patrol_reteach_text').execute({
      inspectionId: 'editable-login',
      stepId: 'step-001',
      selector: '#new-username',
      text: 'new@example.com',
    }, exec)
    await tool('patrol_reteach_credential').execute({
      inspectionId: 'editable-login',
      stepId: 'step-002',
      selector: '#new-password',
      credentialRef: 'NEW_PASSWORD',
    }, exec)

    definition = await store.load('editable-login')
    expect(definition.steps[0]?.id).toBe('step-001')
    expect(definition.steps[0]?.kind === 'tool' ? definition.steps[0].arguments.text : undefined).toBe('new@example.com')
    expect(definition.steps[1]?.id).toBe('step-002')
    expect(definition.steps[1]?.kind === 'tool' ? definition.steps[1].arguments.credentialRef : undefined).toBe('${credential:NEW_PASSWORD}')

    await tool('patrol_validate').execute({ inspectionId: 'editable-login' }, exec)
    definition = await store.load('editable-login')
    expect(definition.metadata.validatedAt).toBeDefined()

    await tool('patrol_confirm_edit').execute({ inspectionId: 'editable-login', confirmed: true }, exec)
    definition = await store.load('editable-login')
    expect(definition.status).toBe('ready')
    expect(definition.schedule?.enabled).toBe(true)
  })

  it('inserts wait and screenshot steps with flat structural tools, reloads persistence, and never executes the current page', async () => {
    const { store, tool, exec, dispatchCalls } = await setup()
    const definition = readyDefinition()
    definition.status = 'draft'
    await store.create(definition)

    const waitResult = await tool('patrol_insert_wait_step').execute({
      inspectionId: 'editable-login',
      stepName: '等待 5 秒',
      timeoutMs: 5000,
      afterStepId: 'step-003',
    }, exec)
    expect(waitResult).toContain('Persistence check: PASSED')
    expect(waitResult).toContain('browser_wait 5000ms')

    const screenshotResult = await tool('patrol_insert_screenshot_step').execute({
      inspectionId: 'editable-login',
      stepName: '打开工单后截图',
      afterStepId: 'step-004',
    }, exec)
    expect(screenshotResult).toContain('Persistence check: PASSED')

    const updated = await store.load('editable-login')
    expect(updated.steps.map(step => step.id)).toEqual(['step-001', 'step-002', 'step-003', 'step-004', 'step-005'])
    expect(updated.steps[3]).toMatchObject({ id: 'step-004', tool: 'browser_wait', arguments: { timeoutMs: 5000 } })
    expect(updated.steps[4]).toMatchObject({ id: 'step-005', tool: 'browser_screenshot', artifact: 'screenshot' })
    expect(dispatchCalls()).toBe(0)
  })

  it('recovers an additive structural edit when the first verified save is clobbered by a stale writer', async () => {
    const { store, tool, exec } = await setup()
    const definition = readyDefinition()
    definition.status = 'draft'
    await store.create(definition)

    const stale = await store.load('editable-login')
    const original = store.saveRunbookEdit.bind(store)
    let clobberOnce = true
    store.saveRunbookEdit = async next => {
      await original(next)
      if (clobberOnce && next.steps.length > stale.steps.length) {
        clobberOnce = false
        await store.save(stale)
      }
    }

    const result = await tool('patrol_insert_wait_step').execute({
      inspectionId: 'editable-login',
      stepName: '等待工单列表加载',
      timeoutMs: 3000,
      afterStepId: 'step-001',
    }, exec)

    expect(result).toContain('Persistence check: PASSED')
    expect(clobberOnce).toBe(false)
    const updated = await store.load('editable-login')
    expect(updated.steps.some(step => step.kind === 'tool'
      && step.tool === 'browser_wait'
      && step.arguments.timeoutMs === 3000)).toBe(true)
  })

  it('inserts page reads with flat parameters and keeps the advanced generic insert as a compatibility fallback', async () => {
    const { store, tool, exec, dispatchCalls } = await setup()
    const definition = readyDefinition()
    definition.status = 'draft'
    await store.create(definition)

    await tool('patrol_insert_read_page_step').execute({
      inspectionId: 'editable-login',
      stepName: '读取工单信息',
      maxChars: 12000,
      afterStepId: 'step-003',
    }, exec)
    await tool('patrol_insert_browser_step').execute({
      inspectionId: 'editable-login',
      stepName: '兼容等待',
      action: 'wait',
      arguments: { timeoutMs: 1000 },
      afterStepId: 'step-004',
    }, exec)

    const updated = await store.load('editable-login')
    expect(updated.steps[3]).toMatchObject({
      id: 'step-004',
      tool: 'browser_read_page',
      arguments: { maxChars: 12000 },
      artifact: 'page-text',
    })
    expect(updated.steps[4]).toMatchObject({ id: 'step-005', tool: 'browser_wait', arguments: { timeoutMs: 1000 } })
    expect(dispatchCalls()).toBe(0)
  })

  it('updates structural wait, screenshot, read-page, and navigate parameters without executing the current page', async () => {
    const { store, tool, exec, dispatchCalls } = await setup()
    const definition = readyDefinition()
    definition.status = 'draft'
    await store.create(definition)

    await tool('patrol_insert_wait_step').execute({
      inspectionId: 'editable-login',
      stepName: '等待 5 秒',
      timeoutMs: 5000,
      afterStepId: 'step-003',
    }, exec)
    await tool('patrol_insert_screenshot_step').execute({
      inspectionId: 'editable-login',
      stepName: '截图',
      afterStepId: 'step-004',
    }, exec)
    await tool('patrol_insert_read_page_step').execute({
      inspectionId: 'editable-login',
      stepName: '读取页面',
      maxChars: 6000,
      afterStepId: 'step-005',
    }, exec)
    await tool('patrol_insert_navigate_step').execute({
      inspectionId: 'editable-login',
      stepName: '打开目标页',
      url: 'https://example.com/old',
      afterStepId: 'step-006',
    }, exec)

    const waitResult = await tool('patrol_update_wait_step').execute({
      inspectionId: 'editable-login',
      stepId: 'step-004',
      timeoutMs: 10000,
      selector: '#ready',
      condition: 'visible',
      stepName: '等待页面稳定',
    }, exec)
    expect(waitResult).toContain('stable id and position preserved')
    expect(waitResult).toContain('Persistence check: PASSED')

    await tool('patrol_update_screenshot_step').execute({
      inspectionId: 'editable-login',
      stepId: 'step-005',
      format: 'jpeg',
      stepName: '稳定后截图',
    }, exec)
    await tool('patrol_update_read_page_step').execute({
      inspectionId: 'editable-login',
      stepId: 'step-006',
      maxChars: 12000,
      capturePageText: false,
    }, exec)
    await tool('patrol_update_navigate_step').execute({
      inspectionId: 'editable-login',
      stepId: 'step-007',
      url: 'https://example.com/new',
      newTab: false,
    }, exec)
    await expect(tool('patrol_update_navigate_step').execute({
      inspectionId: 'editable-login',
      stepId: 'step-007',
      newTab: true,
    }, exec)).rejects.toThrow(/active tab.*not replay-stable/i)

    const updated = await store.load('editable-login')
    expect(updated.steps.map(step => step.id)).toEqual(['step-001', 'step-002', 'step-003', 'step-004', 'step-005', 'step-006', 'step-007'])
    expect(updated.steps[3]).toMatchObject({
      id: 'step-004',
      name: '等待页面稳定',
      tool: 'browser_wait',
      arguments: { timeoutMs: 10000, selector: '#ready', condition: 'visible' },
    })
    expect(updated.steps[4]).toMatchObject({
      id: 'step-005',
      name: '稳定后截图',
      tool: 'browser_screenshot',
      arguments: { format: 'jpeg' },
      artifact: 'screenshot',
    })
    expect(updated.steps[5]).toMatchObject({
      id: 'step-006',
      tool: 'browser_read_page',
      arguments: { maxChars: 12000 },
    })
    expect(updated.steps[5]?.kind === 'tool' ? updated.steps[5].artifact : undefined).toBeUndefined()
    expect(updated.steps[6]).toMatchObject({
      id: 'step-007',
      tool: 'browser_navigate',
      arguments: { url: 'https://example.com/new', action: 'navigate', newTab: false },
    })
    expect(dispatchCalls()).toBe(0)
  })

  it('isolates explicit edits from the production teaching lifecycle and preserves the saved graph through confirmation', async () => {
    const { store, tool, exec, dispatchCalls } = await setup({ lifecycle: true })
    const definition = readyDefinition()
    definition.status = 'draft'
    definition.artifacts = ['screenshot']
    definition.metadata.workspaceRoot = roots[roots.length - 1]
    await store.create(definition)
    if (!(store instanceof PatrolLifecycleStore)) throw new Error('expected lifecycle store')

    // Reproduce production state: an older DRAFT may already have an active
    // interactive-teaching lifecycle when the user asks to optimize it.
    await store.beginTeachingRun('editable-login', definition.metadata.workspaceRoot)
    await tool('patrol_begin_edit').execute({ inspectionId: 'editable-login' }, exec)

    const waitResult = await tool('patrol_insert_wait_step').execute({
      inspectionId: 'editable-login',
      stepName: '等待列表加载',
      timeoutMs: 3000,
      afterStepId: 'step-001',
    }, exec)
    expect(waitResult).toContain('Persistence check: PASSED')

    const screenshotResult = await tool('patrol_insert_screenshot_step').execute({
      inspectionId: 'editable-login',
      stepName: '加载后截图',
      format: 'png',
      afterStepId: 'step-004',
    }, exec)
    expect(screenshotResult).toContain('Persistence check: PASSED')

    let updated = await store.load('editable-login')
    const expectedIds = ['step-001', 'step-004', 'step-005', 'step-002', 'step-003']
    expect(updated.steps.map(step => step.id)).toEqual(expectedIds)
    expect(updated.steps[1]).toMatchObject({ id: 'step-004', tool: 'browser_wait', arguments: { timeoutMs: 3000 } })
    expect(updated.steps[2]).toMatchObject({ id: 'step-005', tool: 'browser_screenshot', artifact: 'screenshot' })

    await tool('patrol_validate').execute({ inspectionId: 'editable-login' }, exec)
    await tool('patrol_confirm_edit').execute({ inspectionId: 'editable-login', confirmed: true }, exec)

    updated = await store.load('editable-login')
    expect(updated.status).toBe('ready')
    expect(updated.steps.map(step => step.id)).toEqual(expectedIds)
    expect(updated.steps[1]).toMatchObject({ id: 'step-004', tool: 'browser_wait', arguments: { timeoutMs: 3000 } })
    expect(updated.steps[2]).toMatchObject({ id: 'step-005', tool: 'browser_screenshot', artifact: 'screenshot' })
    expect(dispatchCalls()).toBe(0)
  })

  it('edits desktop target metadata without converting the flow into a browser target', async () => {
    const { store, tool, exec } = await setup()
    const now = new Date().toISOString()
    const definition: InspectionDefinition = {
      schemaVersion: '0.2',
      id: 'wechat-edit',
      name: '微信桌面流程',
      description: 'desktop metadata edit',
      status: 'ready',
      target: { type: 'desktop', app: '微信', processName: 'WeChat', titleContains: '微信' },
      expectedResult: '完成微信操作',
      artifacts: [],
      auth: { mode: 'none' },
      schedule: null,
      steps: [{
        id: 'step-001',
        kind: 'tool',
        name: '激活微信',
        tool: 'desktop_activate_window',
        arguments: { processName: 'WeChat', titleContains: '微信' },
        recordedAt: now,
      }],
      metadata: {
        createdAt: now,
        updatedAt: now,
        validatedAt: now,
        taskChecklist: ['激活微信'],
      },
    }
    await store.create(definition)

    await tool('patrol_begin_edit').execute({ inspectionId: 'wechat-edit' }, exec)
    await tool('patrol_update_inspection').execute({
      inspectionId: 'wechat-edit',
      desktopApp: '微信 Windows',
      desktopProcessName: 'Weixin',
      clearDesktopTitleContains: true,
    }, exec)

    const updated = await store.load('wechat-edit')
    expect(updated.target).toEqual({
      type: 'desktop',
      app: '微信 Windows',
      processName: 'Weixin',
    })
    await expect(tool('patrol_update_inspection').execute({
      inspectionId: 'wechat-edit',
      targetUrl: 'https://example.com',
    }, exec)).rejects.toThrow(/browser-target inspection/i)
  })

  it('refuses a structural updater when the saved step tool does not match', async () => {
    const { store, tool, exec } = await setup()
    const definition = readyDefinition()
    definition.status = 'draft'
    await store.create(definition)

    await expect(tool('patrol_update_wait_step').execute({
      inspectionId: 'editable-login',
      stepId: 'step-002',
      timeoutMs: 5000,
    }, exec)).rejects.toThrow(/browser_wait is required/i)
  })

  it('refuses to confirm an edited runbook before full validation', async () => {
    const { store, tool, exec } = await setup()
    await store.create(readyDefinition())
    await tool('patrol_begin_edit').execute({ inspectionId: 'editable-login' }, exec)
    await expect(tool('patrol_confirm_edit').execute({ inspectionId: 'editable-login', confirmed: true }, exec)).rejects.toThrow(/has not passed patrol_validate/i)
  })

  it('can clear an obsolete checkpoint condition and notes without changing the step id', async () => {
    const { store, tool, exec } = await setup()
    await store.create(readyDefinition())
    await tool('patrol_begin_edit').execute({ inspectionId: 'editable-login' }, exec)
    await tool('patrol_reteach_checkpoint').execute({
      inspectionId: 'editable-login',
      stepId: 'step-003',
      clearCondition: true,
      clearNotes: true,
      prompt: 'Complete the current human verification, then continue.',
    }, exec)
    const definition = await store.load('editable-login')
    const step = definition.steps[2]
    expect(step?.id).toBe('step-003')
    expect(step?.kind).toBe('checkpoint')
    if (step?.kind === 'checkpoint') {
      expect(step.when).toBeUndefined()
      expect(step.notes).toBeUndefined()
    }
  })
})
