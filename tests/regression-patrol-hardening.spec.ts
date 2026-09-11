import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PATROL_QWEN_SOFT_REQUEST_LIMIT,
  registerPatrolContextPressureGuard,
} from '../src/context-pressure-guard.js'
import { registerPatrolEditTools } from '../src/edit-tools.js'
import { PatrolLifecycleStore } from '../src/lifecycle-store.js'
import type { PatrolRunner } from '../src/runner.js'
import type { PatrolStore } from '../src/store.js'
import { registerPatrolTransientInputTools } from '../src/transient-input-tools.js'
import type { InspectionDefinition, ToolStep } from '../src/types.js'

const roots: string[] = []
const previousCaptchaMode = process.env.DSH_PATROL_CAPTCHA_MODE

afterEach(async () => {
  if (previousCaptchaMode === undefined) delete process.env.DSH_PATROL_CAPTCHA_MODE
  else process.env.DSH_PATROL_CAPTCHA_MODE = previousCaptchaMode
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function toolStep(id: string, name = id): ToolStep {
  return {
    id,
    kind: 'tool',
    name,
    tool: 'browser_click',
    arguments: {},
    recordedAt: new Date().toISOString(),
  }
}

function draftDefinition(id = 'hardening-demo'): InspectionDefinition {
  const now = new Date().toISOString()
  return {
    schemaVersion: '0.2',
    id,
    name: id,
    description: 'regression fixture',
    status: 'draft',
    target: { type: 'browser', url: 'https://example.test/' },
    expectedResult: 'done',
    artifacts: [],
    auth: { mode: 'none' },
    schedule: null,
    steps: [],
    metadata: { createdAt: now, updatedAt: now, taskChecklist: ['执行测试动作'] },
  }
}

describe('Patrol regression hardening', () => {
  it('compacts a high-pressure Patrol step even when final model routing is still unresolved', async () => {
    const ctx = new Context()
    const agent = {
      id: 'patrol-unresolved-route',
      session: {
        requestHeader: () => undefined,
        surface: { replaceGeneration: 0 },
      },
      options: {},
    }
    const compactIfNeeded = vi.fn(async () => {
      agent.session.surface.replaceGeneration += 1
      return { shadowedSeqs: [1] }
    })
    ctx.provide('tokenMeter', { measure: () => ({ totalTokens: PATROL_QWEN_SOFT_REQUEST_LIMIT + 500 }) })
    ctx.provide('compaction', { compactIfNeeded })
    registerPatrolContextPressureGuard(ctx)

    await ctx.waterfall(
      'agent/pre-step',
      {
        agent,
        messages: [],
        turn: 2,
        step: 9,
        signal: new AbortController().signal,
      } as never,
      async () => ({ kind: 'enter' as const, messages: [] }),
    )

    expect(compactIfNeeded).toHaveBeenCalledOnce()
    expect(compactIfNeeded).toHaveBeenCalledWith(agent, 'context-overflow', expect.any(AbortSignal))
    await ctx.fiber.dispose()
  })

  it('moves reused DRAFT teaching into the current workspace and keeps the in-progress history row WAITING', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-lifecycle-hardening-'))
    roots.push(root)
    const store = new PatrolLifecycleStore(join(root, 'store'))
    await store.init()
    const definition = draftDefinition('workspace-draft')
    definition.metadata.workspaceRoot = join(root, 'old-workspace')
    await store.create(definition)

    const currentWorkspace = join(root, 'current-workspace')
    const report = await store.beginTeachingRun(definition.id, currentWorkspace)
    const persisted = await store.load(definition.id)
    const persistedRun = await store.loadRun(definition.id, report.runId)

    expect(persisted.metadata.workspaceRoot).toBe(currentWorkspace)
    expect(report.status).toBe('waiting')
    expect(report.finishedAt).toBe('')
    expect(persistedRun.status).toBe('waiting')
    expect(persistedRun.finishedAt).toBe('')
  })

  it('supports structural correction in the middle of a DRAFT instead of leaving the correction at the tail', async () => {
    const definition = draftDefinition('structural-edit')
    const first = toolStep('step-001', 'first')
    const dependent: ToolStep = {
      ...toolStep('step-002', 'dependent'),
      when: {
        sourceStepId: 'step-001',
        mode: 'contains',
        value: 'ok',
        caseSensitive: false,
      },
    }
    const correction = toolStep('step-003', 'new correction')
    definition.steps = [first, dependent, correction]

    const save = vi.fn(async () => {})
    const store = {
      loadResume: vi.fn(async () => undefined),
      load: vi.fn(async () => definition),
      save,
    } as unknown as PatrolStore
    const definitions: any[] = []
    const ctx = {
      tools: {
        register(tool: any) {
          definitions.push(tool)
          return () => {}
        },
      },
    } as unknown as Context
    registerPatrolEditTools(ctx, store, {} as PatrolRunner)

    const move = definitions.find(tool => tool.name === 'patrol_move_step')
    const remove = definitions.find(tool => tool.name === 'patrol_remove_steps')
    expect(move).toBeDefined()
    expect(remove).toBeDefined()

    await move.execute({
      inspectionId: definition.id,
      stepId: 'step-003',
      afterStepId: 'step-001',
    })
    expect(definition.steps.map(step => step.id)).toEqual(['step-001', 'step-003', 'step-002'])

    await expect(remove.execute({
      inspectionId: definition.id,
      stepIds: ['step-001'],
    })).rejects.toThrow(/still depend|depend/i)
    expect(definition.steps.map(step => step.id)).toEqual(['step-001', 'step-003', 'step-002'])
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('uses the local verification detector first in TEST MODE and records only a dynamic image-code solver step', async () => {
    process.env.DSH_PATROL_CAPTCHA_MODE = 'test'
    const definition = draftDefinition('ocr-first')
    const save = vi.fn(async () => {})
    const store = {
      load: vi.fn(async () => definition),
      save,
    } as unknown as PatrolStore
    const dispatch = vi.fn(async () => ({
      ok: true,
      text: 'Auth challenge handled without exposing its value.',
      value: {
        ok: true,
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
    }))
    const definitions: any[] = []
    const ctx = {
      tools: {
        register(tool: any) {
          definitions.push(tool)
          return () => {}
        },
      },
    } as unknown as Context
    registerPatrolTransientInputTools(ctx, store, { dispatch } as unknown as PatrolRunner)
    const solve = definitions.find(tool => tool.name === 'patrol_solve_current_image_code')
    expect(solve).toBeDefined()

    const result = await solve.execute({ inspectionId: definition.id }, { token: Symbol('exec') })

    expect(dispatch).toHaveBeenCalledWith('browser_detect_auth_challenge', {}, expect.anything())
    expect(definition.steps).toHaveLength(1)
    expect(definition.steps[0]?.tool).toBe('browser_detect_auth_challenge')
    expect(definition.steps[0]?.arguments).toEqual({})
    expect(result).toContain('dynamic solver step')
    expect(save).toHaveBeenCalledOnce()
  })
})
