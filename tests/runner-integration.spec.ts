import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { canReuseAuthenticatedSession, PatrolRunner } from '../src/runner.ts'
import { PatrolStore } from '../src/store.ts'
import type { InspectionDefinition } from '../src/types.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function setup(execute: (input: { name: string; arguments: unknown }) => Promise<unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-runner-'))
  roots.push(root)
  const store = new PatrolStore(root)
  await store.init()
  const ctx = { tools: { execute } } as unknown as Context
  const runner = new PatrolRunner(ctx, store, { reportMaxChars: 30000 })
  const exec = {
    token: Symbol('patrol-parent'),
    rootCallId: 'root',
    signal: new AbortController().signal,
  } as unknown as ToolRunContext
  return { root, store, runner, exec }
}

function definition(steps: InspectionDefinition['steps'], artifacts: InspectionDefinition['artifacts'] = []): InspectionDefinition {
  return {
    schemaVersion: '0.2',
    id: 'test',
    name: 'test',
    description: 'test patrol',
    status: 'ready',
    target: { type: 'browser', url: 'https://example.com' },
    expectedResult: 'ok',
    artifacts,
    auth: { mode: 'none' },
    schedule: null,
    steps,
    metadata: {
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      validatedAt: '2026-01-01T00:00:00.000Z',
    },
  }
}

const at = '2026-01-01T00:00:00.000Z'

describe('PatrolRunner integration safety', () => {
  it('fails an explicit screenshot step when the provider returns no path', async () => {
    const { runner, exec } = await setup(async () => ({
      isError: false,
      value: { ok: true },
      content: [{ type: 'text', text: 'screenshot returned without path' }],
    }))
    const def = definition([{ id: 'step-001', kind: 'tool', name: 'shot', tool: 'browser_screenshot', arguments: {}, artifact: 'screenshot', recordedAt: at }], ['screenshot'])
    const { report } = await runner.run(def, exec)
    expect(report.status).toBe('failed')
    expect(report.results[0]?.error).toMatch(/no artifact path/i)
  })

  it('auto-captures a final screenshot when the artifact contract requests one but the Runbook has no screenshot step', async () => {
    let screenshotCalls = 0
    let providerPath = ''
    const fixture = await setup(async input => {
      if (input.name === 'browser_navigate') {
        return { isError: false, value: { ok: true }, content: [{ type: 'text', text: 'navigated' }] }
      }
      if (input.name === 'browser_screenshot') {
        screenshotCalls += 1
        return { isError: false, value: { ok: true, path: providerPath }, content: [{ type: 'text', text: 'captured' }] }
      }
      throw new Error(`unexpected tool ${input.name}`)
    })
    providerPath = join(fixture.root, 'screenshot-loose.png')
    await writeFile(providerPath, 'fake png')
    const def = definition([{ id: 'step-001', kind: 'tool', name: 'navigate', tool: 'browser_navigate', arguments: { url: 'https://example.com' }, recordedAt: at }], ['screenshot'])
    def.metadata.workspaceRoot = fixture.root
    ;(fixture.exec as any).agent = { session: { header: { cwd: fixture.root } } }

    const { report } = await fixture.runner.run(def, fixture.exec)

    expect(report.status).toBe('passed')
    expect(report.warnings).toBeUndefined()
    expect(screenshotCalls).toBe(1)
    expect(report.results.at(-1)).toMatchObject({
      stepId: 'artifact-final-screenshot',
      status: 'passed',
      artifacts: [{ kind: 'screenshot' }],
    })
    expect(report.results.at(-1)?.artifacts?.[0]?.path).toContain('patrol-results')
    await expect(access(providerPath)).rejects.toThrow()
  })

  it('does not duplicate screenshots when the Runbook already produced the required screenshot artifact', async () => {
    let screenshotCalls = 0
    let providerPath = ''
    const fixture = await setup(async input => {
      if (input.name !== 'browser_screenshot') throw new Error(`unexpected tool ${input.name}`)
      screenshotCalls += 1
      return { isError: false, value: { ok: true, path: providerPath }, content: [{ type: 'text', text: 'captured' }] }
    })
    providerPath = join(fixture.root, 'provider.png')
    await writeFile(providerPath, 'fake png')
    const def = definition([{ id: 'step-001', kind: 'tool', name: 'shot', tool: 'browser_screenshot', arguments: {}, artifact: 'screenshot', recordedAt: at }], ['screenshot'])

    const { report } = await fixture.runner.run(def, fixture.exec)

    expect(report.status).toBe('passed')
    expect(screenshotCalls).toBe(1)
    expect(report.results.map(item => item.stepId)).toEqual(['step-001'])
  })

  it('keeps a successful business replay passed when automatic final screenshot capture fails', async () => {
    const { runner, exec } = await setup(async input => {
      if (input.name === 'browser_navigate') {
        return { isError: false, value: { ok: true }, content: [{ type: 'text', text: 'navigated' }] }
      }
      if (input.name === 'browser_screenshot') {
        return { isError: true, error: new Error('capture backend unavailable'), value: {}, content: [{ type: 'text', text: 'capture failed' }] }
      }
      throw new Error(`unexpected tool ${input.name}`)
    })
    const def = definition([{ id: 'step-001', kind: 'tool', name: 'navigate', tool: 'browser_navigate', arguments: { url: 'https://example.com' }, recordedAt: at }], ['screenshot'])

    const { report } = await runner.run(def, exec)

    expect(report.status).toBe('passed')
    expect(report.results.at(-1)?.stepId).toBe('artifact-final-screenshot')
    expect(report.results.at(-1)?.status).toBe('skipped')
    expect(report.warnings?.join('\n')).toMatch(/final screenshot artifact capture failed.*capture backend unavailable/i)
  })

  it('treats missing page-summary evidence as a warning instead of a business replay failure', async () => {
    const { runner, exec } = await setup(async () => ({
      isError: false,
      value: { ok: true, connected: true },
      content: [{ type: 'text', text: 'connected' }],
    }))
    const def = definition([{ id: 'step-001', kind: 'tool', name: 'navigate', tool: 'browser_navigate', arguments: { url: 'https://example.com' }, recordedAt: at }], ['page-summary'])
    const { report } = await runner.run(def, exec)
    expect(report.status).toBe('passed')
    expect(report.warnings?.join('\n')).toMatch(/page-summary/i)
  })

  it('treats missing page-text evidence as a warning instead of a business replay failure', async () => {
    const { runner, exec } = await setup(async () => ({
      isError: false,
      value: { ok: true },
      content: [{ type: 'text', text: 'navigated' }],
    }))
    const def = definition([{ id: 'step-001', kind: 'tool', name: 'navigate', tool: 'browser_navigate', arguments: { url: 'https://example.com' }, recordedAt: at }], ['page-text'])
    const { report } = await runner.run(def, exec)
    expect(report.status).toBe('passed')
    expect(report.warnings?.join('\n')).toMatch(/page-text/i)
  })

  it('only reuses an authenticated browser session inside the current flow site scope', () => {
    const def = definition([
      { id: 'step-001', kind: 'tool', name: 'navigate app', tool: 'browser_navigate', arguments: { url: 'https://example.com/login' }, recordedAt: at },
      { id: 'step-002', kind: 'tool', name: 'navigate sso', tool: 'browser_navigate', arguments: { url: 'https://sso.example.com/start' }, recordedAt: at },
    ])
    expect(canReuseAuthenticatedSession(def, 'https://example.com/workbench')).toBe(true)
    expect(canReuseAuthenticatedSession(def, 'https://sso.example.com/callback')).toBe(true)
    expect(canReuseAuthenticatedSession(def, 'https://other.example.com/dashboard')).toBe(false)
    expect(canReuseAuthenticatedSession(def, 'chrome://newtab/')).toBe(false)
  })

  it('does not skip a login step merely because a different Patrol site is authenticated', async () => {
    const calls: string[] = []
    const { runner, exec } = await setup(async input => {
      calls.push(input.name)
      if (input.name === 'browser_login_state') {
        return {
          isError: false,
          value: { ok: true, state: 'authenticated', url: 'https://other.example.com/dashboard' },
          content: [{ type: 'text', text: 'authenticated elsewhere' }],
        }
      }
      if (input.name === 'browser_type') {
        return {
          isError: false,
          value: { ok: true, selector: '#username' },
          content: [{ type: 'text', text: 'typed' }],
        }
      }
      throw new Error(`unexpected tool ${input.name}`)
    })
    const def = definition([{
      id: 'step-001',
      kind: 'tool',
      name: '输入用户名',
      tool: 'browser_type',
      arguments: { selector: '#username', text: 'public-user' },
      recordedAt: at,
    }])

    const { report } = await runner.run(def, exec)

    expect(report.status).toBe('passed')
    expect(calls).toEqual(['browser_login_state', 'browser_type'])
  })

  it('reuses a login step when authenticated evidence belongs to the same flow site scope', async () => {
    const calls: string[] = []
    const { runner, exec } = await setup(async input => {
      calls.push(input.name)
      if (input.name === 'browser_login_state') {
        return {
          isError: false,
          value: { ok: true, state: 'authenticated', url: 'https://example.com/workbench' },
          content: [{ type: 'text', text: 'authenticated here' }],
        }
      }
      throw new Error(`unexpected tool ${input.name}`)
    })
    const def = definition([{
      id: 'step-001',
      kind: 'tool',
      name: '输入用户名',
      tool: 'browser_type',
      arguments: { selector: '#username', text: 'public-user' },
      recordedAt: at,
    }])

    const { report } = await runner.run(def, exec)

    expect(report.status).toBe('passed')
    expect(calls).toEqual(['browser_login_state'])
    expect(report.results[0]?.output).toMatch(/within this flow's known site scope/i)
  })

  it('verifies a replayed click against the resulting page instead of the browser_click acknowledgement', async () => {
    const calls: string[] = []
    const { runner, exec } = await setup(async input => {
      calls.push(input.name)
      if (input.name === 'browser_snapshot') {
        return {
          isError: false,
          value: {
            ok: true,
            elements: [
              { tag: 'a', role: 'link', text: '我的工作台', selector: 'top-frame::#workbench' },
            ],
          },
          content: [{ type: 'text', text: 'snapshot' }],
        }
      }
      if (input.name === 'browser_click') {
        return {
          isError: false,
          value: { ok: true, selector: '#workbench' },
          content: [{ type: 'text', text: 'Clicked #workbench' }],
        }
      }
      if (input.name === 'browser_read_page') {
        return {
          isError: false,
          value: { ok: true, text: '工作台侧栏 待办待阅工单' },
          content: [{ type: 'text', text: '工作台侧栏 待办待阅工单' }],
        }
      }
      throw new Error(`unexpected tool ${input.name}`)
    })

    const def = definition([{
      id: 'step-001',
      kind: 'tool',
      name: '点击我的工作台',
      tool: 'browser_click',
      arguments: { selector: 'top-frame::#workbench' },
      locator: { text: '我的工作台', role: 'link', tag: 'a' },
      expectation: { mode: 'contains', value: '待办待阅工单', caseSensitive: false },
      recordedAt: at,
    }])

    const { report } = await runner.run(def, exec)
    expect(report.status).toBe('passed')
    expect(calls).toEqual(['browser_snapshot', 'browser_click', 'browser_read_page'])
  })

  it('refuses to resume a runbook edited after the checkpoint', async () => {
    const { store, runner, exec } = await setup(async () => ({
      isError: false,
      value: { ok: true },
      content: [{ type: 'text', text: 'ok' }],
    }))
    const def = definition([{ id: 'step-001', kind: 'checkpoint', name: 'manual', prompt: '请完成审批', reason: 'approval', recordedAt: at }])
    const first = await runner.run(def, exec)
    expect(first.report.status).toBe('waiting')
    const changed = { ...def, metadata: { ...def.metadata, updatedAt: '2026-01-02T00:00:00.000Z' } }
    await expect(runner.resume(changed, exec)).rejects.toThrow(/changed after run/i)
    expect(await store.loadResume(def.id)).toBeDefined()
  })
})