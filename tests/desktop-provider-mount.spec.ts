import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { PatrolRunner } from '../src/runner.js'
import { PatrolStore } from '../src/store.js'
import { PATROL_DESKTOP_PROMPT } from '../src/desktop-prompt.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('desktop provider mounting regression', () => {
  it('reports a missing desktop provider before dispatching a valid desktop action', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-provider-missing-'))
    roots.push(root)
    const store = new PatrolStore(root)
    await store.init()

    let executeCalls = 0
    const ctx = {
      tools: {
        get() { return undefined },
        async execute() {
          executeCalls += 1
          throw new Error('should not execute a missing provider')
        },
      },
    } as unknown as Context

    const runner = new PatrolRunner(ctx, store, { reportMaxChars: 30000 })
    const exec = {
      token: Symbol('desktop-provider-missing'),
      rootCallId: 'root',
      signal: new AbortController().signal,
    } as unknown as ToolRunContext

    const result = await runner.dispatch('desktop_activate_window', { processName: 'AnyDesktopApp' }, exec)

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/requested tool desktop_activate_window is valid but unavailable/i)
    expect(result.error).toMatch(/generic Patrol preset\/provider loading problem/i)
    expect(result.error).toContain('dsh-patrol/desktop-tools')
    expect(result.error).toMatch(/NEW Patrol session/i)
    expect(executeCalls).toBe(0)
  })

  it('tells the agent to execute one-off desktop requests directly instead of creating a flow first', () => {
    expect(PATROL_DESKTOP_PROMPT).toContain('一次性 CURRENT 桌面任务')
    expect(PATROL_DESKTOP_PROMPT).toContain('不要为了执行一次动作先创建 inspection、task checklist 或 DRAFT Runbook')
    expect(PATROL_DESKTOP_PROMPT).toContain('desktop_activate_window 是合法的 Desktop Automation action')
    expect(PATROL_DESKTOP_PROMPT).toContain('不属于某个具体应用')
  })
})
