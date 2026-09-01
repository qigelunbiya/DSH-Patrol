import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { registerPatrolHandoffTools } from '../src/handoff-tools.ts'
import { PatrolRunner } from '../src/runner.ts'
import { PatrolStore } from '../src/store.ts'
import type { InspectionDefinition, JsonObject } from '../src/types.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

type DetectorProfile = {
  ok?: boolean
  kind: 'none' | 'otp' | 'captcha' | 'slider' | 'approval' | 'unknown'
  subtype?: string
  observedSubtype?: string
  autoFilled?: boolean
  handoffRequired?: boolean
  error?: string
}

async function setup(profile: DetectorProfile) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-handoff-'))
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
      if (tool === 'browser_detect_auth_challenge') {
        const ok = profile.ok !== false
        const subtype = profile.subtype ?? (profile.kind === 'none' ? 'none' : profile.kind)
        const observedSubtype = profile.observedSubtype ?? subtype
        const handoffRequired = profile.handoffRequired ?? profile.kind !== 'none'
        if (!ok) return { ok: false, text: '', error: profile.error ?? 'image-code automation failed' }
        return {
          ok: true,
          text: `Auth challenge: kind=${profile.kind}; subtype=${subtype}; observed=${profile.kind}/${observedSubtype}; hasChallenge=${profile.kind !== 'none'}; handoffRequired=${handoffRequired}`,
          value: {
            ok: true,
            kind: profile.kind,
            subtype,
            observedKind: profile.kind,
            observedSubtype,
            hasChallenge: profile.kind !== 'none',
            handoffRequired,
            autoFilled: profile.autoFilled,
            selectors: [],
          },
        }
      }
      if (tool === 'browser_screenshot') {
        return { ok: true, text: `Screenshot saved: ${join(root, 'browser-tmp', 'challenge.png')}`, value: { ok: true, path: join(root, 'browser-tmp', 'challenge.png'), bytes: 1000 } }
      }
      return { ok: true, text: 'ok', value: { ok: true } }
    },
  } as unknown as PatrolRunner

  registerPatrolHandoffTools(ctx, store, runner, { maxSteps: 20 })
  const tool = definitions.find(item => item.name === 'patrol_prepare_verification_handoff')
  if (!tool) throw new Error('patrol_prepare_verification_handoff not registered')
  const exec = {
    token: Symbol('handoff-test'),
    rootCallId: 'root',
    signal: new AbortController().signal,
  } as unknown as ToolRunContext
  return { root, store, tool, calls, exec }
}

function draftDefinition(): InspectionDefinition {
  const now = new Date().toISOString()
  return {
    schemaVersion: '0.2',
    id: 'verification-handoff',
    name: 'Verification handoff',
    description: 'Capture verification evidence and pause for the user',
    status: 'draft',
    target: { type: 'browser', url: 'https://example.com/login' },
    expectedResult: 'logged in',
    artifacts: ['screenshot'],
    auth: { mode: 'secret-ref' },
    schedule: null,
    steps: [{
      id: 'step-001',
      kind: 'tool',
      name: 'Detect verification',
      tool: 'browser_detect_auth_challenge',
      arguments: {},
      recordedAt: now,
    }],
    metadata: { createdAt: now, updatedAt: now },
  }
}

describe('Patrol human verification handoff', () => {
  it('records one conditional screenshot and checkpoint for genuinely human-only OTP', async () => {
    const { store, tool, exec } = await setup({ kind: 'otp', subtype: 'otp', handoffRequired: true })
    await tool.execute({ inspectionId: 'verification-handoff', detectorStepId: 'step-001' }, exec)

    const definition = await store.load('verification-handoff')
    expect(definition.steps).toHaveLength(3)
    const screenshot = definition.steps[1]
    const checkpoint = definition.steps[2]
    expect(screenshot?.kind).toBe('tool')
    if (screenshot?.kind === 'tool') {
      expect(screenshot.tool).toBe('browser_screenshot')
      expect(screenshot.artifact).toBe('screenshot')
      expect(screenshot.when).toEqual({ sourceStepId: 'step-001', mode: 'not-contains', value: 'kind=none', caseSensitive: false })
    }
    expect(checkpoint?.kind).toBe('checkpoint')
    if (checkpoint?.kind === 'checkpoint') {
      expect(checkpoint.when).toEqual({ sourceStepId: 'step-001', mode: 'not-contains', value: 'kind=none', caseSensitive: false })
      expect(checkpoint.prompt).not.toMatch(/password|captcha answer|验证码[:：=]/i)
    }
  })

  it('captures immediate evidence for a remaining human-only slider', async () => {
    const { root, tool, calls, exec } = await setup({ kind: 'slider', subtype: 'slider-puzzle', handoffRequired: true })
    const result = await tool.execute({ inspectionId: 'verification-handoff', detectorStepId: 'step-001', tabId: 7 }, exec)
    expect(calls).toEqual([
      { tool: 'browser_detect_auth_challenge', args: { tabId: 7 } },
      { tool: 'browser_screenshot', args: { tabId: 7, format: 'png' } },
    ])
    expect(result).toContain('kind=slider')
    expect(result).toContain(join(root, 'browser-tmp', 'challenge.png'))
    expect(result).toContain('human-only verification')
  })

  it('records nothing when no human verification remains', async () => {
    const { store, tool, calls, exec } = await setup({ kind: 'none', subtype: 'none', handoffRequired: false })
    const result = await tool.execute({ inspectionId: 'verification-handoff', detectorStepId: 'step-001' }, exec)
    expect(calls).toEqual([{ tool: 'browser_detect_auth_challenge', args: {} }])
    expect(result).toContain('No remaining human-only verification')
    expect((await store.load('verification-handoff')).steps).toHaveLength(1)
  })

  it('never records a handoff after an automatically filled conventional image-code', async () => {
    const { store, tool, calls, exec } = await setup({
      kind: 'none',
      subtype: 'none',
      observedSubtype: 'image-code',
      autoFilled: true,
      handoffRequired: false,
    })
    const result = await tool.execute({ inspectionId: 'verification-handoff', detectorStepId: 'step-001' }, exec)
    expect(calls).toEqual([{ tool: 'browser_detect_auth_challenge', args: {} }])
    expect(result).toMatch(/image-code.*automatically/i)
    expect((await store.load('verification-handoff')).steps).toHaveLength(1)
  })

  it('fails closed and records no checkpoint when image-code automation fails', async () => {
    const { store, tool, calls, exec } = await setup({
      ok: false,
      kind: 'captcha',
      subtype: 'image-code',
      observedSubtype: 'image-code',
      error: 'DSH Patrol image-code automation failed',
    })
    await expect(tool.execute({ inspectionId: 'verification-handoff', detectorStepId: 'step-001' }, exec))
      .rejects.toThrow(/no human handoff was recorded|image-code automation failed/i)
    expect(calls).toEqual([{ tool: 'browser_detect_auth_challenge', args: {} }])
    expect((await store.load('verification-handoff')).steps).toHaveLength(1)
  })

  it('rejects duplicate handoff recording for the same detector', async () => {
    const { tool, exec } = await setup({ kind: 'otp', subtype: 'otp', handoffRequired: true })
    await tool.execute({ inspectionId: 'verification-handoff', detectorStepId: 'step-001' }, exec)
    await expect(tool.execute({ inspectionId: 'verification-handoff', detectorStepId: 'step-001' }, exec)).rejects.toThrow(/already exists/i)
  })
})
