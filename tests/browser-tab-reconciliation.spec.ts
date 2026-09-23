import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import {
  captureBrowserTabBaseline,
  reconcileFreshBrowserTabs,
} from '../src/browser-tab-reconciliation.js'

const exec = {
  token: Symbol('tab-reconciliation'),
  rootCallId: 'root',
  signal: new AbortController().signal,
} as unknown as ToolRunContext

describe('browser fresh-tab reconciliation', () => {
  it('keeps 龙之信条2, closes only the wrong fresh sibling, and never touches old tabs', async () => {
    let listCalls = 0
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
    const runner = {
      async dispatch(tool: string, args: Record<string, unknown>) {
        calls.push({ tool, args })
        if (tool === 'browser_list_tabs') {
          listCalls += 1
          return {
            ok: true,
            value: {
              tabs: listCalls === 1
                ? [
                    { id: 1, title: '百度搜索', url: 'https://www.baidu.com/s?wd=龙之信条2', active: true },
                    { id: 2, title: '原来就打开的工作页', url: 'https://example.test/work', active: false },
                  ]
                : [
                    { id: 1, title: '百度搜索', url: 'https://www.baidu.com/s?wd=龙之信条2', active: true },
                    { id: 2, title: '原来就打开的工作页', url: 'https://example.test/work', active: false },
                    { id: 9, title: '龙之信条_百度百科', url: 'https://baike.baidu.com/item/龙之信条', active: false },
                    { id: 10, title: '龙之信条2_百度百科', url: 'https://baike.baidu.com/item/龙之信条2', active: false },
                  ],
            },
          }
        }
        if (tool === 'browser_activate_tab') return { ok: true, value: { tab: { id: args.tabId } } }
        if (tool === 'browser_close_tab') return { ok: true, value: { tabId: args.tabId } }
        throw new Error(`unexpected tool ${tool}`)
      },
    } as any

    const baseline = await captureBrowserTabBaseline(runner, exec)
    const result = await reconcileFreshBrowserTabs(runner, exec, baseline, '龙之信条 2 - 百度百科')

    expect(result?.selected?.id).toBe(10)
    expect(result?.closedTabIds).toEqual([9])
    expect(result?.freshTabs.map(tab => tab.id)).toEqual([9, 10])
    expect(calls).toContainEqual({ tool: 'browser_activate_tab', args: { tabId: 10 } })
    expect(calls).toContainEqual({ tool: 'browser_close_tab', args: { tabId: 9 } })
    expect(calls).not.toContainEqual({ tool: 'browser_close_tab', args: { tabId: 2 } })
  })

  it('preserves every fresh tab when two candidates are equally plausible', async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
    const runner = {
      async dispatch(tool: string, args: Record<string, unknown>) {
        calls.push({ tool, args })
        if (tool === 'browser_list_tabs') {
          return {
            ok: true,
            value: {
              tabs: [
                { id: 1, title: '来源页', url: 'https://example.test/source', active: true },
                { id: 20, title: '报告详情', url: 'https://example.test/a', active: false },
                { id: 21, title: '报告详情', url: 'https://example.test/b', active: false },
              ],
            },
          }
        }
        throw new Error(`unexpected tool ${tool}`)
      },
    } as any

    const result = await reconcileFreshBrowserTabs(
      runner,
      exec,
      { ids: new Set([1]) },
      '报告详情',
    )

    expect(result?.ambiguous).toBe(true)
    expect(result?.closedTabIds).toEqual([])
    expect(calls.some(call => call.tool === 'browser_close_tab')).toBe(false)
    expect(calls.some(call => call.tool === 'browser_activate_tab')).toBe(false)
  })

  it('degrades to the old click path when tab tooling is unavailable', async () => {
    const runner = {
      async dispatch() {
        throw new Error('browser tab tooling unavailable')
      },
    } as any

    expect(await captureBrowserTabBaseline(runner, exec)).toBeUndefined()
    expect(await reconcileFreshBrowserTabs(runner, exec, undefined, '目标')).toBeUndefined()
  })
})
