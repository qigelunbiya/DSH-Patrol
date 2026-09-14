import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearTransientSecrets } from '../browser-bridge-runtime/transient-secret-store.js'
import { registerPatrolTransientInputTools } from '../src/transient-input-tools.ts'
import type { PatrolRunner } from '../src/runner.ts'
import type { PatrolStore } from '../src/store.ts'

const roots: string[] = []
const previousOverride = process.env.DSH_PATROL_SECRET_DIR
const previousCaptchaMode = process.env.DSH_PATROL_CAPTCHA_MODE

afterEach(async () => {
  clearTransientSecrets()
  if (previousOverride === undefined) delete process.env.DSH_PATROL_SECRET_DIR
  else process.env.DSH_PATROL_SECRET_DIR = previousOverride
  if (previousCaptchaMode === undefined) delete process.env.DSH_PATROL_CAPTCHA_MODE
  else process.env.DSH_PATROL_CAPTCHA_MODE = previousCaptchaMode
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function draft(taskChecklist = ['填写验证码']) {
  return {
    schemaVersion: '0.2',
    id: 'demo',
    name: 'demo',
    description: 'demo',
    status: 'draft',
    target: { type: 'browser', url: 'https://example.test/' },
    expectedResult: 'demo',
    artifacts: [],
    auth: { mode: 'manual-checkpoint' },
    schedule: null,
    steps: [] as any[],
    metadata: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), taskChecklist },
  }
}

describe('Patrol encrypted sensitive input', () => {
  it('types an already-supplied secret and stores only an encrypted durable reference', async () => {
    const secretRoot = await mkdtemp(join(tmpdir(), 'dsh-patrol-sensitive-input-'))
    roots.push(secretRoot)
    process.env.DSH_PATROL_SECRET_DIR = secretRoot
    clearTransientSecrets()

    const definitions: any[] = []
    const ctx = { tools: { register(definition: any) { definitions.push(definition); return () => {} } } } as unknown as Context
    const inspection = draft(['填写密码'])
    const save = vi.fn(async () => {})
    const store = { load: vi.fn(async () => inspection), save } as unknown as PatrolStore
    const dispatch = vi.fn(async () => ({ ok: true, text: 'Typed public text into #password.' }))
    const runner = { dispatch } as unknown as PatrolRunner

    registerPatrolTransientInputTools(ctx, store, runner)
    const tool = definitions.find(item => item.name === 'patrol_type_transient')
    const secret = 'example-sensitive-value'
    const result = await tool.execute({ inspectionId: 'demo', stepName: 'fill supplied password', selector: '#password', text: secret, clear: true }, { token: Symbol('exec') })

    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch.mock.calls[0]?.[0]).toBe('browser_type')
    expect(dispatch.mock.calls[0]?.[1]).toEqual({ selector: '#password', text: secret, clear: true })
    expect(dispatch.mock.calls[0]?.[3]).toEqual([secret])
    expect(save).toHaveBeenCalledTimes(1)
    expect(inspection.steps).toHaveLength(1)
    expect(inspection.steps[0].tool).toBe('browser_type_transient_ref')
    expect(inspection.steps[0].arguments.transientRef).toMatch(/^PATROL_SECRET_[A-F0-9]+$/)
    expect(JSON.stringify(inspection)).not.toContain(secret)
    expect(result).not.toContain(secret)
    expect(result).toContain('encrypted')
  })

  it('redacts text from the visible tool-call card', () => {
    const definitions: any[] = []
    const ctx = { tools: { register(definition: any) { definitions.push(definition); return () => {} } } } as unknown as Context
    registerPatrolTransientInputTools(ctx, {} as PatrolStore, {} as PatrolRunner)
    const tool = definitions.find(item => item.name === 'patrol_type_transient')
    const card = tool.presentCall({ inspectionId: 'demo', stepName: 'password', selector: '#password', text: 'never-display-me' })
    expect(JSON.stringify(card)).not.toContain('never-display-me')
    expect(JSON.stringify(card)).toContain('[REDACTED]')
  })

  it('compatibility solve entrypoint performs no local OCR dispatch in TEST MODE', async () => {
    process.env.DSH_PATROL_CAPTCHA_MODE = 'test'
    const definitions: any[] = []
    const ctx = { tools: { register(definition: any) { definitions.push(definition); return () => {} } } } as unknown as Context
    const inspection = draft()
    const dispatch = vi.fn(async () => ({ ok: true, text: 'unexpected' }))
    const store = { load: vi.fn(async () => inspection), save: vi.fn(async () => {}) } as unknown as PatrolStore
    registerPatrolTransientInputTools(ctx, store, { dispatch } as unknown as PatrolRunner)
    const tool = definitions.find(item => item.name === 'patrol_solve_current_image_code')

    const result = await tool.execute({ inspectionId: 'demo' }, { token: Symbol('exec') })
    expect(dispatch).not.toHaveBeenCalled()
    expect(result).toContain('no local OCR was executed')
    expect(result).toContain('browser_capture_image_code_visual')
  })

  it('does not type a low-confidence current image-code', async () => {
    process.env.DSH_PATROL_CAPTCHA_MODE = 'test'
    const definitions: any[] = []
    const ctx = { tools: { register(definition: any) { definitions.push(definition); return () => {} } } } as unknown as Context
    const dispatch = vi.fn(async () => ({ ok: true, text: 'typed' }))
    registerPatrolTransientInputTools(ctx, {} as PatrolStore, { dispatch } as unknown as PatrolRunner)
    const tool = definitions.find(item => item.name === 'patrol_type_current_image_code')

    const result = await tool.execute({ inspectionId: 'demo', selector: '#captcha', text: 'AD4T', confidence: 0.86, source: 'model-visual' }, { token: Symbol('exec') })
    expect(dispatch).not.toHaveBeenCalled()
    expect(result).toContain('NOT typed')
    expect(result).toContain('0.90')
  })

  it('refuses model image-code answers that contain multiple candidates', async () => {
    process.env.DSH_PATROL_CAPTCHA_MODE = 'test'
    const definitions: any[] = []
    const ctx = { tools: { register(definition: any) { definitions.push(definition); return () => {} } } } as unknown as Context
    const dispatch = vi.fn(async () => ({ ok: true, text: 'typed' }))
    registerPatrolTransientInputTools(ctx, {} as PatrolStore, { dispatch } as unknown as PatrolRunner)
    const tool = definitions.find(item => item.name === 'patrol_type_current_image_code')

    await expect(tool.execute({ inspectionId: 'demo', selector: '#captcha', text: 'IXBF or 1KBF', confidence: 0.96, source: 'model-visual' }, { token: Symbol('exec') })).rejects.toThrow(/single candidate/i)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('types a high-confidence current image-code and records one value-free dynamic replay solver', async () => {
    process.env.DSH_PATROL_CAPTCHA_MODE = 'test'
    const definitions: any[] = []
    const ctx = { tools: { register(definition: any) { definitions.push(definition); return () => {} } } } as unknown as Context
    const dispatch = vi.fn(async () => ({ ok: true, text: 'typed' }))
    const inspection = draft()
    const save = vi.fn(async () => {})
    const store = { save, load: vi.fn(async () => inspection) } as unknown as PatrolStore
    registerPatrolTransientInputTools(ctx, store, { dispatch } as unknown as PatrolRunner)
    const tool = definitions.find(item => item.name === 'patrol_type_current_image_code')
    const code = 'RKHF'

    const card = tool.presentCall({ inspectionId: 'demo', selector: '#captcha', text: code, confidence: 0.93, source: 'model-visual' })
    expect(JSON.stringify(card)).not.toContain(code)

    const first = await tool.execute({ inspectionId: 'demo', selector: '#captcha', text: code, confidence: 0.93, source: 'model-visual', clear: true }, { token: Symbol('exec') })
    const second = await tool.execute({ inspectionId: 'demo', selector: '#captcha', text: 'ABCD', confidence: 0.95, source: 'model-visual', clear: true }, { token: Symbol('exec') })

    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(inspection.steps).toHaveLength(1)
    expect(inspection.steps[0]).toMatchObject({ tool: 'browser_detect_auth_challenge', arguments: {} })
    expect(JSON.stringify(inspection)).not.toContain(code)
    expect(save).toHaveBeenCalledTimes(1)
    expect(first).toContain('Recorded')
    expect(second).toContain('Reused existing')
    expect(first).not.toContain(code)
  })

  it('keeps the current image-code tool disabled in normal mode', async () => {
    process.env.DSH_PATROL_CAPTCHA_MODE = 'normal'
    const definitions: any[] = []
    const ctx = { tools: { register(definition: any) { definitions.push(definition); return () => {} } } } as unknown as Context
    registerPatrolTransientInputTools(ctx, {} as PatrolStore, {} as PatrolRunner)
    const tool = definitions.find(item => item.name === 'patrol_type_current_image_code')

    await expect(tool.execute({ inspectionId: 'demo', selector: '#captcha', text: 'ABCD', confidence: 0.95 }, { token: Symbol('exec') })).rejects.toThrow(/TEST MODE/)
  })
})
