import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { PatrolRunner } from '../src/runner.ts'
import { PatrolStore } from '../src/store.ts'
import type { InspectionDefinition } from '../src/types.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(execute: (input: { name: string; arguments: any }) => Promise<any>) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-adaptive-runner-'))
  roots.push(root)
  const store = new PatrolStore(root)
  await store.init()
  const ctx = { tools: { execute } } as unknown as Context
  const runner = new PatrolRunner(ctx, store, { reportMaxChars: 30000 })
  const exec = {
    token: Symbol('adaptive-parent'),
    rootCallId: 'root',
    signal: new AbortController().signal,
  } as unknown as ToolRunContext
  return { runner, exec }
}

function definition(): InspectionDefinition {
  const at = '2026-01-01T00:00:00.000Z'
  return {
    schemaVersion: '0.2',
    id: 'adaptive-login',
    name: 'adaptive login',
    description: 'test',
    status: 'ready',
    target: { type: 'browser', url: 'https://example.test/login' },
    expectedResult: 'logged in',
    artifacts: [],
    auth: { mode: 'none' },
    schedule: null,
    steps: [
      {
        id: 'step-001',
        kind: 'tool',
        name: '输入用户名',
        tool: 'browser_type',
        arguments: { selector: '#username', text: 'public-user' },
        recordedAt: at,
      },
      {
        id: 'step-002',
        kind: 'tool',
        name: '继续',
        tool: 'browser_click',
        arguments: { selector: '#continue' },
        recordedAt: at,
      },
    ],
    metadata: {
      createdAt: at,
      updatedAt: at,
      taskChecklist: ['输入用户名', '点击继续'],
    },
  }
}

describe('adaptive PatrolRunner replay', () => {
  it('recovers one username selector drift and continues later Runbook steps without mutating the flow', async () => {
    const calls: Array<{ name: string; arguments: any }> = []
    const { runner, exec } = await fixture(async input => {
      calls.push(input)
      if (input.name === 'browser_login_state') {
        return {
          isError: false,
          value: { ok: true, state: 'login-required', url: 'https://example.test/login' },
          content: [{ type: 'text', text: 'login required' }],
        }
      }
      if (input.name === 'browser_type' && input.arguments.selector === '#username') {
        return {
          isError: true,
          error: new Error('element not found in any accessible frame: #username'),
          value: {},
          content: [{ type: 'text', text: 'missing' }],
        }
      }
      if (input.name === 'browser_snapshot') {
        return {
          isError: false,
          value: {
            ok: true,
            url: 'https://example.test/login',
            elements: [
              { tag: 'input', type: 'text', name: 'accountName', selector: 'input[name="accountName"]' },
            ],
          },
          content: [{ type: 'text', text: 'snapshot' }],
        }
      }
      if (input.name === 'browser_type' && input.arguments.selector === 'input[name="accountName"]') {
        return {
          isError: false,
          value: { ok: true, selector: input.arguments.selector },
          content: [{ type: 'text', text: 'typed recovered field' }],
        }
      }
      if (input.name === 'browser_click') {
        return {
          isError: false,
          value: { ok: true, selector: '#continue' },
          content: [{ type: 'text', text: 'clicked continue' }],
        }
      }
      throw new Error(`unexpected tool ${input.name}`)
    })

    const def = definition()
    const originalSteps = JSON.stringify(def.steps)
    const { report } = await runner.run(def, exec)

    expect(report.status).toBe('passed')
    expect(report.results[0]).toMatchObject({
      stepId: 'step-001',
      status: 'passed',
      healedSelector: 'input[name="accountName"]',
    })
    expect(report.results[1]).toMatchObject({ stepId: 'step-002', status: 'passed' })
    expect(report.warnings?.join('\n')).toMatch(/recovered selector drift/i)
    expect(JSON.stringify(def.steps)).toBe(originalSteps)
    expect(calls.map(call => call.name)).toEqual([
      'browser_login_state',
      'browser_type',
      'browser_snapshot',
      'browser_type',
      'browser_click',
    ])
  })
})
