import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { PatrolRunner } from '../src/runner.ts'
import type { PatrolStore } from '../src/store.ts'


describe('browser execution guard', () => {
  it('allows only a nested call while PatrolRunner.dispatch owns the parent token', async () => {
    let runner: PatrolRunner
    const token = Symbol('patrol-parent')
    const ctx = {
      tools: {
        async execute(input: { name: string; parent?: ToolRunContext['token'] }) {
          expect(runner.browserGuard(input.name, input.parent)).toBeUndefined()
          return { isError: false, value: { ok: true, connected: true }, content: [{ type: 'text', text: 'connected' }] }
        },
      },
    } as unknown as Context
    runner = new PatrolRunner(ctx, {} as PatrolStore, { reportMaxChars: 30000 })
    const exec = {
      token,
      rootCallId: 'root',
      signal: new AbortController().signal,
    } as unknown as ToolRunContext

    expect(runner.browserGuard('browser_status', undefined)).toMatch(/blocks browser tools/i)
    expect(runner.browserGuard('browser_status', token)).toMatch(/blocks browser tools/i)
    await expect(runner.dispatch('browser_status', {}, exec)).resolves.toMatchObject({ ok: true })
    expect(runner.browserGuard('browser_status', token)).toMatch(/blocks browser tools/i)
    expect(runner.isToolAllowed('browser_eval')).toBe(false)
  })
})
