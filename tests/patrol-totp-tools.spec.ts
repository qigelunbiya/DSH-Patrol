import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { registerPatrolTotpTools } from '../src/totp-tools.ts'
import { PatrolStore } from '../src/store.ts'
import type { InspectionDefinition } from '../src/types.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function setup(dispatchOk = true) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-totp-runbook-'))
  roots.push(root)
  const store = new PatrolStore(root)
  await store.init()
  const now = new Date().toISOString()
  const inspection: InspectionDefinition = {
    schemaVersion: '0.2',
    id: 'totp-login',
    name: 'TOTP login',
    description: 'test',
    status: 'draft',
    target: { type: 'browser', url: 'https://example.test/login' },
    expectedResult: 'logged in',
    artifacts: [],
    auth: { mode: 'secret-ref' },
    schedule: null,
    steps: [],
    metadata: { createdAt: now, updatedAt: now },
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
    get() {
      return undefined
    },
  } as unknown as Context
  const calls: any[] = []
  const runner = {
    async dispatch(name: string, args: any) {
      calls.push({ name, args })
      return dispatchOk
        ? { ok: true, text: 'TOTP typed without exposing digits' }
        : { ok: false, error: 'profile unavailable', text: '' }
    },
  } as any

  registerPatrolTotpTools(ctx, store, runner, { maxSteps: 20 })
  const tool = definitions.find(item => item.name === 'patrol_type_totp_profile')
  if (!tool) throw new Error('patrol_type_totp_profile not registered')
  return { store, tool, calls }
}

describe('Patrol TOTP Runbook tool', () => {
  it('records only the opaque token profile reference after successful typing', async () => {
    const { store, tool, calls } = await setup(true)
    const result = await tool.execute({
      inspectionId: 'totp-login',
      stepName: 'Fill APP token',
      selector: '#otp',
      profileId: 'ops-login',
    }, {})

    expect(calls).toEqual([{
      name: 'browser_type_totp_profile',
      args: { selector: '#otp', profileId: 'ops-login', clear: true },
    }])
    expect(result).toContain('ops-login')
    expect(result).not.toMatch(/\b\d{6,8}\b/)

    const saved = await store.load('totp-login')
    expect(saved.steps).toHaveLength(1)
    expect(saved.steps[0]).toMatchObject({
      tool: 'browser_type_totp_profile',
      sensitive: true,
      arguments: { selector: '#otp', profileId: 'ops-login', clear: true },
    })
    expect(JSON.stringify(saved)).not.toContain('otpauth://')
    expect(JSON.stringify(saved)).not.toContain('secret=')
  })

  it('does not record a step when the configured profile cannot be used', async () => {
    const { store, tool } = await setup(false)
    const result = await tool.execute({
      inspectionId: 'totp-login',
      stepName: 'Fill APP token',
      selector: '#otp',
      profileId: 'missing-profile',
    }, {})

    expect(result).toContain('NOT recorded')
    expect((await store.load('totp-login')).steps).toEqual([])
  })

  it('rejects attempts to smuggle a seed or path through profileId', async () => {
    const { tool } = await setup(true)
    await expect(tool.execute({
      inspectionId: 'totp-login',
      stepName: 'Fill APP token',
      selector: '#otp',
      profileId: '../secret',
    }, {})).rejects.toThrow(/profile id/i)
  })
})
