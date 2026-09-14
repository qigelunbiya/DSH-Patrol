import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerPatrolTransientInputTools } from '../src/transient-input-tools.ts'
import type { PatrolRunner } from '../src/runner.ts'
import type { PatrolStore } from '../src/store.ts'

const previousCaptchaMode = process.env.DSH_PATROL_CAPTCHA_MODE

afterEach(() => {
  if (previousCaptchaMode === undefined) delete process.env.DSH_PATROL_CAPTCHA_MODE
  else process.env.DSH_PATROL_CAPTCHA_MODE = previousCaptchaMode
})

function draft() {
  const now = new Date().toISOString()
  return {
    schemaVersion: '0.2',
    id: 'ops-ADBBAF',
    name: 'ops',
    description: 'ops',
    status: 'draft',
    target: { type: 'browser', url: 'https://example.test/login' },
    expectedResult: 'done',
    artifacts: [],
    auth: { mode: 'manual-checkpoint' },
    schedule: null,
    steps: [] as any[],
    metadata: {
      createdAt: now,
      updatedAt: now,
      taskChecklist: ['识别并填写四位数英文验证码（没有数字）'],
    },
  }
}

async function setup() {
  process.env.DSH_PATROL_CAPTCHA_MODE = 'test'
  const definitions: any[] = []
  const ctx = { tools: { register(definition: any) { definitions.push(definition); return () => {} } } } as unknown as Context
  const inspection = draft()
  const save = vi.fn(async () => {})
  const store = { load: vi.fn(async () => inspection), save } as unknown as PatrolStore
  const dispatch = vi.fn(async () => ({ ok: true, text: 'typed' }))
  registerPatrolTransientInputTools(ctx, store, { dispatch } as unknown as PatrolRunner)
  const tool = definitions.find(item => item.name === 'patrol_type_current_image_code')
  if (!tool) throw new Error('patrol_type_current_image_code not registered')
  return { inspection, save, dispatch, tool }
}

describe('persisted image-code task contract', () => {
  it('refuses a high-confidence candidate containing a digit when the checklist says letters-only', async () => {
    const { dispatch, save, tool } = await setup()

    const result = await tool.execute({
      inspectionId: 'ops-ADBBAF',
      selector: '#captcha',
      text: 'VC4A',
      confidence: 0.99,
      source: 'model-visual',
      clear: true,
    }, { token: Symbol('exec') })

    expect(dispatch).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
    expect(result).toContain('NOT typed')
    expect(result).toContain('letters-only/no-digits')
  })

  it('accepts exactly four ASCII letters and records the dynamic replay solver step', async () => {
    const { inspection, dispatch, save, tool } = await setup()

    const result = await tool.execute({
      inspectionId: 'ops-ADBBAF',
      selector: '#captcha',
      text: 'VCZA',
      confidence: 0.99,
      source: 'model-visual',
      clear: true,
    }, { token: Symbol('exec') })

    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch.mock.calls[0]?.[0]).toBe('browser_type')
    expect(inspection.steps).toHaveLength(1)
    expect(inspection.steps[0].tool).toBe('browser_detect_auth_challenge')
    expect(save).toHaveBeenCalledTimes(1)
    expect(result).toContain('length=4')
    expect(result).toContain('letters-only/no-digits')
  })
})
