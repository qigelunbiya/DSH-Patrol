import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PATROL_BEHAVIOR_PROMPT } from '../src/behavior-prompt.ts'
import { PATROL_SYSTEM_PROMPT } from '../src/prompt.ts'
import { PATROL_PAGE_UNDERSTANDING_PROMPT } from '../src/page-understanding-tools.ts'
import { PATROL_TRANSIENT_INPUT_PROMPT, registerPatrolTransientInputTools } from '../src/transient-input-tools.ts'
import { PATROL_TEST_MODE_OVERRIDE_PROMPT } from '../src/test-mode.ts'
import { PatrolStore } from '../src/store.ts'
import type { InspectionDefinition } from '../src/types.ts'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function setup(detectorResult: any) {
  vi.stubEnv('DSH_PATROL_CAPTCHA_MODE', 'test')
  const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-image-code-routing-'))
  roots.push(root)
  const store = new PatrolStore(root)
  await store.init()
  const now = new Date().toISOString()
  const inspection: InspectionDefinition = {
    schemaVersion: '0.2',
    id: 'captcha-login',
    name: 'CAPTCHA login',
    description: 'test',
    status: 'draft',
    target: { type: 'browser', url: 'https://example.test/login' },
    expectedResult: 'logged in',
    artifacts: [],
    auth: { mode: 'manual-checkpoint' },
    schedule: null,
    steps: [],
    metadata: {
      createdAt: now,
      updatedAt: now,
      taskChecklist: ['输入用户名', '输入密码', '识别并填写四位英文字母验证码', '点击登录'],
    },
  }
  await store.create(inspection)

  const definitions: any[] = []
  const ctx = {
    tools: {
      register(definition: any) {
        definitions.push(definition)
        return () => {}
      },
    },
  } as unknown as Context
  const calls: any[] = []
  const runner = {
    async dispatch(name: string, args: any) {
      calls.push({ name, args })
      return detectorResult
    },
  } as any

  registerPatrolTransientInputTools(ctx, store, runner)
  const solve = definitions.find(item => item.name === 'patrol_solve_current_image_code')
  if (!solve) throw new Error('patrol_solve_current_image_code not registered')
  return { store, solve, calls }
}

describe('TEST MODE image-code routing', () => {
  it('runs the local browser detector first and records the dynamic solver when local OCR auto-fills', async () => {
    const { store, solve, calls } = await setup({
      ok: true,
      text: 'Auth challenge: strategy=windows-system-ocr; verification input auto-filled by the local Patrol solver',
      value: {
        ok: true,
        hasChallenge: false,
        kind: 'none',
        subtype: 'none',
        observedKind: 'captcha',
        observedSubtype: 'image-code',
        strategy: 'windows-system-ocr',
        selectors: ['#captcha'],
        autoFilled: true,
        handoffRequired: false,
        testModeFallback: false,
      },
    })

    const result = await solve.execute({
      inspectionId: 'captcha-login',
      stepName: '识别并填写验证码',
    }, {})

    expect(calls).toEqual([{ name: 'browser_detect_auth_challenge', args: {} }])
    expect(result).toContain('local OCR auto-filled')
    expect(result).not.toContain('Now call browser_capture_image_code_visual')

    const saved = await store.load('captcha-login')
    expect(saved.steps).toHaveLength(1)
    expect(saved.steps[0]).toMatchObject({
      tool: 'browser_detect_auth_challenge',
      arguments: {},
    })
    expect(saved.steps[0]?.notes).toContain('PATROL_DYNAMIC_IMAGE_CODE_SOLVER')
    expect(saved.steps[0]?.notes).toContain('本地 OCR')
    expect(saved.steps[0]?.notes).not.toContain('教学阶段使用 CURRENT 模型视觉')
  })

  it('authorizes model vision only after an explicit detector fallback result', async () => {
    const { store, solve, calls } = await setup({
      ok: true,
      text: 'Auth challenge: strategy=model-visual-test; TEST MODE fallback is active',
      value: {
        ok: true,
        hasChallenge: true,
        kind: 'captcha',
        subtype: 'image-code',
        observedKind: 'captcha',
        observedSubtype: 'image-code',
        strategy: 'model-visual-test',
        selectors: ['#captcha'],
        autoFilled: false,
        handoffRequired: false,
        testModeFallback: true,
      },
    })

    const result = await solve.execute({ inspectionId: 'captcha-login' }, {})

    expect(calls).toEqual([{ name: 'browser_detect_auth_challenge', args: {} }])
    expect(result).toContain('browser_capture_image_code_visual')
    expect(result).toContain('fallbackToken=')
    expect(result).toContain('one-use')
    expect(result).toContain('patrol_type_current_image_code')
    expect((await store.load('captcha-login')).steps).toEqual([])
  })

  it('does not silently switch to model vision on a detector transport/tool failure', async () => {
    const { store, solve } = await setup({
      ok: false,
      text: '',
      error: 'page bridge unavailable',
    })

    const result = await solve.execute({ inspectionId: 'captcha-login' }, {})

    expect(result).toContain('local OCR attempt failed')
    expect(result).toContain('Model vision is allowed only after an explicit detector fallback result')
    expect(result).not.toContain('Now call browser_capture_image_code_visual')
    expect((await store.load('captcha-login')).steps).toEqual([])
  })

  it('keeps all injected CAPTCHA guidance aligned on local OCR before model vision', () => {
    for (const prompt of [
      PATROL_SYSTEM_PROMPT,
      PATROL_BEHAVIOR_PROMPT,
      PATROL_TRANSIENT_INPUT_PROMPT,
      PATROL_TEST_MODE_OVERRIDE_PROMPT,
      PATROL_PAGE_UNDERSTANDING_PROMPT,
    ]) {
      expect(prompt).toContain('patrol_solve_current_image_code')
      expect(prompt).toContain('browser_capture_image_code_visual')
      expect(prompt.indexOf('patrol_solve_current_image_code')).toBeLessThan(prompt.indexOf('browser_capture_image_code_visual'))
    }
    expect(PATROL_TRANSIENT_INPUT_PROMPT).toContain('browser_detect_auth_challenge')
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toContain('browser_detect_auth_challenge')
    expect(PATROL_TRANSIENT_INPUT_PROMPT).not.toContain('TEST MODE 交互教学使用视觉优先')
    expect(PATROL_TRANSIENT_INPUT_PROMPT).not.toContain('不要先运行本地 ddddocr/Windows OCR 预检')
    expect(PATROL_PAGE_UNDERSTANDING_PROMPT).not.toContain('TEST MODE 的交互教学直接使用 browser_capture_image_code_visual')
    expect(PATROL_PAGE_UNDERSTANDING_PROMPT).toContain('一次性 fallbackToken')
  })
})