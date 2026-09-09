import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { verifyPostClickExpectation } from '../src/post-click-verification.ts'
import type { JsonObject, TextExpectation } from '../src/types.ts'

const exec = {
  token: Symbol('post-click-test'),
  rootCallId: 'root',
  signal: new AbortController().signal,
} as unknown as ToolRunContext

const containsWorkbench: TextExpectation = {
  mode: 'contains',
  value: '待办待阅工单',
  caseSensitive: false,
}

describe('post-click page verification', () => {
  it('survives a transient page-bridge loss caused by navigation and verifies the resulting page', async () => {
    const calls: Array<{ tool: string; args: JsonObject }> = []
    let read = 0
    const result = await verifyPostClickExpectation(async (tool, args) => {
      calls.push({ tool, args })
      read += 1
      if (read === 1) {
        return {
          ok: false,
          text: '',
          error: 'Receiving end does not exist because the old document navigated away',
        }
      }
      return {
        ok: true,
        text: '工作台 待办待阅工单',
        value: { ok: true, text: '工作台 待办待阅工单' },
      }
    }, exec, containsWorkbench, 17, [0, 0])

    expect(result).toMatchObject({ ok: true, attempts: 2 })
    expect(calls).toEqual([
      { tool: 'browser_read_page', args: { tabId: 17 } },
      { tool: 'browser_read_page', args: { tabId: 17 } },
    ])
  })

  it('retries a readable old state while an asynchronous portal click is still transitioning', async () => {
    let reads = 0
    const result = await verifyPostClickExpectation(async () => {
      reads += 1
      const text = reads < 3 ? '首页 统计分析' : '首页 左侧菜单 待办待阅工单'
      return { ok: true, text, value: { ok: true, text } }
    }, exec, containsWorkbench, undefined, [0, 0, 0])

    expect(result).toMatchObject({ ok: true, attempts: 3 })
    expect(reads).toBe(3)
  })

  it('fails after the bounded retry window when a readable page never reaches the business expectation', async () => {
    let reads = 0
    const result = await verifyPostClickExpectation(async () => {
      reads += 1
      return {
        ok: true,
        text: '首页 统计分析',
        value: { ok: true, text: '首页 统计分析' },
      }
    }, exec, containsWorkbench, undefined, [0, 0, 0])

    expect(result.ok).toBe(false)
    expect(result.error).toContain('expected post-click page to contain')
    expect(reads).toBe(3)
  })
})
