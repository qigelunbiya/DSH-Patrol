import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { registerPatrolActionTools } from '../src/action-tools.ts'
import { PatrolStore } from '../src/store.ts'
import type { InspectionDefinition, JsonObject } from '../src/types.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function draft(): InspectionDefinition {
  const now = new Date().toISOString()
  return {
    schemaVersion: '0.2',
    id: 'raw-click-change',
    name: 'Raw click change',
    description: 'test',
    status: 'draft',
    target: { type: 'browser', url: 'https://example.test/login' },
    expectedResult: 'modal opens',
    artifacts: [],
    auth: { mode: 'none' },
    schedule: null,
    steps: [],
    metadata: { createdAt: now, updatedAt: now, taskChecklist: ['点击目标'] },
  }
}

describe('raw patrol_click automatic state verification', () => {
  it('records a successful click without expectedText when a modal appears', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-raw-click-'))
    roots.push(root)
    const store = new PatrolStore(root)
    await store.init()
    await store.create(draft())

    const definitions: any[] = []
    const ctx = { tools: { register(definition: any) { definitions.push(definition); return () => {} } } } as unknown as Context
    let clicked = false
    const runner = {
      async dispatch(name: string, _args: JsonObject) {
        if (name === 'browser_click') {
          clicked = true
          return { ok: true, text: 'clicked', value: { ok: true } }
        }
        if (name === 'browser_read_page') {
          return clicked
            ? { ok: true, text: '双因子认证 APP口令 确定', value: { ok: true, url: 'https://example.test/login', text: '双因子认证 APP口令 确定' } }
            : { ok: true, text: '用户名 密码 验证码 登录', value: { ok: true, url: 'https://example.test/login', text: '用户名 密码 验证码 登录' } }
        }
        if (name === 'browser_snapshot') {
          return clicked
            ? { ok: true, text: 'modal', value: { ok: true, url: 'https://example.test/login', elements: [{ tag: 'button', text: '确定', selector: 'top-frame::button.login_button' }] } }
            : { ok: true, text: 'login', value: { ok: true, url: 'https://example.test/login', elements: [{ tag: 'button', text: '登录', selector: 'top-frame::button.login_button' }] } }
        }
        throw new Error(`unexpected tool ${name}`)
      },
    } as any

    registerPatrolActionTools(ctx, store, runner, { maxSteps: 20 })
    const clickTool = definitions.find(item => item.name === 'patrol_click')
    const exec = { token: Symbol('test'), rootCallId: 'root', signal: new AbortController().signal } as unknown as ToolRunContext

    const result = await clickTool.execute({
      inspectionId: 'raw-click-change',
      stepName: '点击登录',
      selector: '#login',
    }, exec)

    expect(result).toContain('automatic CURRENT-state change')
    const saved = await store.load('raw-click-change')
    expect(saved.steps).toHaveLength(1)
    expect(saved.steps[0]).toMatchObject({
      tool: 'browser_click',
      arguments: { selector: '#login' },
      teaching: { status: 'verified', method: 'state-change' },
    })
  })
})
