import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { registerPatrolActionTools } from '../src/action-tools.ts'
import { PatrolLifecycleStore } from '../src/lifecycle-store.ts'
import { PatrolRunner } from '../src/runner.ts'
import { PatrolStore } from '../src/store.ts'
import type { InspectionDefinition, JsonObject } from '../src/types.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function setup(env: Record<string, string | undefined> = {}) {
  const previousCaptchaMode = process.env.DSH_PATROL_CAPTCHA_MODE
  setCaptchaMode(env.DSH_PATROL_CAPTCHA_MODE)
  try {
    const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-actions-'))
    roots.push(root)
    const store = new PatrolStore(root)
    await store.init()
    await store.create(draftDefinition())

    const definitions: any[] = []
    const calls: Array<{ tool: string; args: JsonObject }> = []
    const ctx = {
      tools: {
        register(definition: any) {
          definitions.push(definition)
          return () => {}
        },
      },
    } as unknown as Context

    const runner = {
      async dispatch(tool: string, args: JsonObject) {
        calls.push({ tool, args })
        if (tool === 'browser_count') return { ok: true, text: `Count .row: 4 element(s) (visible only).`, value: { ok: true, count: 4 } }
        if (tool === 'browser_read_page') return { ok: true, text: 'Page: Tasks\n\nrow one\nrow two', value: { ok: true } }
        return { ok: true, text: 'ok', value: { ok: true } }
      },
    } as unknown as PatrolRunner

    registerPatrolActionTools(ctx, store, runner, { maxSteps: 50 })
    const tool = (name: string) => {
      const found = definitions.find(item => item.name === name)
      if (!found) throw new Error(`tool ${name} not registered`)
      return found
    }
    const exec = {
      token: Symbol('action-test'),
      rootCallId: 'root',
      signal: new AbortController().signal,
    } as unknown as ToolRunContext

    return { store, calls, tool, definitions, exec }
  } finally {
    setCaptchaMode(previousCaptchaMode)
  }
}

function setCaptchaMode(value: string | undefined): void {
  if (value === undefined) delete process.env.DSH_PATROL_CAPTCHA_MODE
  else process.env.DSH_PATROL_CAPTCHA_MODE = value
}

function draftDefinition(): InspectionDefinition {
  const now = new Date().toISOString()
  return {
    schemaVersion: '0.2',
    id: 'flat-actions',
    name: 'Flat actions',
    description: 'Flat action tool test',
    status: 'draft',
    target: { type: 'browser', url: 'https://example.com' },
    expectedResult: 'four rows',
    artifacts: ['screenshot', 'page-text'],
    auth: { mode: 'none' },
    schedule: null,
    steps: [],
    metadata: { createdAt: now, updatedAt: now },
  }
}

describe('flat Patrol action tools', () => {
  it('registers model-facing actions without a nested arguments parameter', async () => {
    const { definitions } = await setup()
    for (const name of ['patrol_navigate', 'patrol_snapshot', 'patrol_read_page', 'patrol_count', 'patrol_refresh_image_code', 'patrol_click', 'patrol_wait', 'patrol_screenshot']) {
      const definition = definitions.find(item => item.name === name)
      expect(definition).toBeDefined()
      expect(definition.parameters.arguments).toBeUndefined()
    }
    expect(definitions.find(item => item.name === 'patrol_detect_auth_challenge')).toBeUndefined()
  })

  it('keeps the legacy auth challenge detector only in normal captcha mode', async () => {
    const { definitions } = await setup({ DSH_PATROL_CAPTCHA_MODE: 'normal' })
    expect(definitions.find(item => item.name === 'patrol_detect_auth_challenge')).toBeDefined()
    expect(definitions.find(item => item.name === 'patrol_refresh_image_code')).toBeDefined()
  })

  it('refreshes the current image-code through a Patrol-owned wrapper without recording a runbook step', async () => {
    const { store, calls, tool, exec } = await setup()
    const result = await tool('patrol_refresh_image_code').execute({
      inspectionId: 'flat-actions',
      stepName: '换一张验证码',
      inputSelector: '#captcha',
      imageSelector: '#captcha-img',
    }, exec)

    expect(result).toContain('Refreshed CURRENT image-code')
    expect(calls).toEqual([{ tool: 'browser_refresh_image_code', args: { inputSelector: '#captcha', imageSelector: '#captcha-img' } }])
    expect((await store.load('flat-actions')).steps).toHaveLength(0)
  })

  it('navigates using flat URL fields and stores provider arguments as an object', async () => {
    const { store, calls, tool, exec } = await setup()
    await tool('patrol_navigate').execute({
      inspectionId: 'flat-actions',
      stepName: 'Open IDC',
      url: 'http://10.192.1.121:8069/web/login',
    }, exec)

    expect(calls[0]).toEqual({
      tool: 'browser_navigate',
      args: { url: 'http://10.192.1.121:8069/web/login', action: 'navigate' },
    })
    const definition = await store.load('flat-actions')
    expect(definition.steps[0]?.kind).toBe('tool')
    if (definition.steps[0]?.kind === 'tool') {
      expect(definition.steps[0].arguments).toEqual({ url: 'http://10.192.1.121:8069/web/login', action: 'navigate' })
      expect(definition.steps[0].notes).toContain('执行方法')
      expect(definition.steps[0].notes).toContain('http://10.192.1.121:8069/web/login')
    }
  })

  it('records an exact count assertion without generic JSON arguments', async () => {
    const { store, tool, exec } = await setup()
    await tool('patrol_count').execute({
      inspectionId: 'flat-actions',
      stepName: 'Verify task rows',
      selector: '.row',
      expectedCount: 4,
    }, exec)

    const definition = await store.load('flat-actions')
    const step = definition.steps[0]
    expect(step?.kind).toBe('tool')
    if (step?.kind === 'tool') {
      expect(step.tool).toBe('browser_count')
      expect(step.arguments).toEqual({ selector: '.row' })
      expect(step.expectation?.value).toBe(': 4 element(s)')
      expect(step.notes).toContain('执行方法')
      expect(step.notes).toContain('.row')
      expect(step.notes).toContain('成功判定')
    }
  })

  it('captures page text by default and screenshots as artifacts', async () => {
    const { store, tool, exec } = await setup()
    await tool('patrol_read_page').execute({ inspectionId: 'flat-actions', stepName: 'Read tasks' }, exec)
    await tool('patrol_screenshot').execute({ inspectionId: 'flat-actions', stepName: 'Capture tasks', format: 'png' }, exec)

    const definition = await store.load('flat-actions')
    expect(definition.steps[0]?.kind === 'tool' ? definition.steps[0].artifact : undefined).toBe('page-text')
    expect(definition.steps[1]?.kind === 'tool' ? definition.steps[1].artifact : undefined).toBe('screenshot')
  })

  it('adds read-page and screenshot outputs to the live interactive teaching report', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-actions-live-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    const shot = join(root, 'browser-shot.png')
    await writeFile(shot, Buffer.from([1, 2, 3, 4]))

    const store = new PatrolLifecycleStore(root)
    await store.init()
    const draft = draftDefinition()
    draft.id = 'live-actions'
    draft.metadata.workspaceRoot = workspace
    await store.create(draft)

    const definitions: any[] = []
    const ctx = { tools: { register(definition: any) { definitions.push(definition); return () => {} } } } as unknown as Context
    const runner = {
      async dispatch(tool: string) {
        if (tool === 'browser_read_page') return { ok: true, text: 'Page: Tasks\n\nrow one\nrow two', value: { ok: true, text: 'Page: Tasks\n\nrow one\nrow two' } }
        if (tool === 'browser_screenshot') return { ok: true, text: `Screenshot saved: ${shot}`, value: { ok: true, path: shot } }
        return { ok: true, text: 'ok', value: { ok: true } }
      },
    } as unknown as PatrolRunner
    registerPatrolActionTools(ctx, store, runner, { maxSteps: 50 })
    const tool = (name: string) => definitions.find(item => item.name === name)
    const exec = {
      token: Symbol('action-live-test'),
      rootCallId: 'root',
      signal: new AbortController().signal,
      agent: { session: { header: { cwd: workspace } } },
    } as unknown as ToolRunContext

    await tool('patrol_read_page').execute({ inspectionId: 'live-actions', stepName: 'Read result' }, exec)
    const screenshotOutput = await tool('patrol_screenshot').execute({ inspectionId: 'live-actions', stepName: 'Capture result', format: 'png' }, exec)
    expect(screenshotOutput).toContain('![巡检截图](<')

    const runIds = await readdir(join(root, 'runs', 'live-actions'))
    const report = await store.loadRun('live-actions', runIds[0]!)
    expect(report.results[0]?.output).toContain('Page: Tasks')
    expect(report.results[0]?.artifacts?.[0]?.kind).toBe('page-text')
    expect(report.results[1]?.artifacts?.[0]?.kind).toBe('screenshot')
    expect(report.results[1]?.artifacts?.[0]?.path).toContain(join('patrol-results', 'live-actions', 'teaching', 'screenshots'))

    const ready = await store.load('live-actions')
    ready.status = 'ready'
    ready.metadata.validatedAt = '2026-09-02T03:00:00.000Z'
    ready.metadata.updatedAt = '2026-09-02T03:00:00.000Z'
    await store.save(ready)

    const finalized = await store.loadRun('live-actions', runIds[0]!)
    expect(finalized.status).toBe('passed')
    expect(finalized.summary).toContain('row one')
    expect(finalized.results.flatMap(result => result.artifacts ?? []).map(artifact => artifact.kind)).toEqual(['page-text', 'screenshot'])
  })
})
