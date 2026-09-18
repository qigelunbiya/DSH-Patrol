import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { registerPatrolTools } from '../src/tools.js'
import { PatrolStore } from '../src/store.js'
import type { InspectionDefinition } from '../src/types.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function setup(definition: InspectionDefinition) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-doctor-plane-'))
  roots.push(root)
  const store = new PatrolStore(root)
  await store.init()
  await store.create(definition)

  const definitions: any[] = []
  const dispatches: string[] = []
  const ctx = {
    tools: {
      register(tool: any) {
        definitions.push(tool)
        return () => {}
      },
      get(name: string) {
        if (name.startsWith('desktop_')) return {}
        return undefined
      },
    },
    get() { return undefined },
  } as unknown as Context
  const runner = {
    async dispatch(name: string) {
      dispatches.push(name)
      if (name === 'desktop_status') return { ok: true, text: 'desktop ready' }
      if (name === 'browser_status') return { ok: true, text: 'browser ready' }
      return { ok: false, text: '', error: `unexpected dispatch ${name}` }
    },
  } as any

  registerPatrolTools(ctx, store, runner, { maxSteps: 50, reportMaxChars: 30_000 })
  const doctor = definitions.find(item => item.name === 'patrol_doctor')
  if (!doctor) throw new Error('patrol_doctor not registered')
  return { doctor, dispatches }
}

function desktopOnlyDefinition(): InspectionDefinition {
  const now = '2026-09-18T04:00:00.000Z'
  return {
    schemaVersion: '0.2',
    id: 'wechat-doctor',
    name: '微信桌面巡检',
    description: 'desktop-only doctor',
    status: 'draft',
    target: { type: 'desktop', app: '微信', processName: 'WeChat' },
    expectedResult: '微信可操作',
    artifacts: [],
    auth: { mode: 'none' },
    schedule: null,
    steps: [{
      id: 'step-001',
      kind: 'tool',
      name: '激活微信',
      tool: 'desktop_activate_window',
      arguments: { processName: 'WeChat' },
      recordedAt: now,
    }],
    metadata: { createdAt: now, updatedAt: now },
  }
}

describe('inspection-aware patrol_doctor', () => {
  it('does not treat missing browser tools as a blocker for desktop-only flows', async () => {
    const { doctor, dispatches } = await setup(desktopOnlyDefinition())

    const output = await doctor.execute({ inspectionId: 'wechat-doctor' }, {
      agent: {},
      token: Symbol('doctor'),
      rootCallId: 'root',
      signal: new AbortController().signal,
    })

    expect(output).toContain('desktop target; browser=optional; desktop=required')
    expect(output).toContain('browser provider: optional for this saved flow')
    expect(output).not.toContain('browser provider: MISSING')
    expect(output).toContain('desktop provider: desktop ready')
    expect(dispatches).toEqual(['desktop_status'])
  })

  it('requires both planes once a browser-target Runbook contains desktop steps', async () => {
    const mixed = desktopOnlyDefinition()
    mixed.id = 'mixed-doctor'
    mixed.target = { type: 'browser', url: 'https://example.com' }
    mixed.steps = [
      {
        id: 'step-001',
        kind: 'tool',
        name: '打开网页',
        tool: 'browser_navigate',
        arguments: { url: 'https://example.com' },
        recordedAt: mixed.metadata.createdAt,
      },
      {
        id: 'step-002',
        kind: 'tool',
        name: '激活微信',
        tool: 'desktop_activate_window',
        arguments: { processName: 'WeChat' },
        recordedAt: mixed.metadata.createdAt,
      },
    ]
    const { doctor, dispatches } = await setup(mixed)

    const output = await doctor.execute({ inspectionId: 'mixed-doctor' }, {
      agent: {},
      token: Symbol('doctor-mixed'),
      rootCallId: 'root',
      signal: new AbortController().signal,
    })

    expect(output).toContain('browser target; browser=required; desktop=required')
    expect(output).toContain('browser provider: MISSING')
    expect(output).toContain('desktop provider: desktop ready')
    expect(dispatches).toEqual(['desktop_status'])
  })
})
