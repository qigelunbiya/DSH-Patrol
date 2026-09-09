import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

function loadHarness(countByFrame: Record<number, number>) {
  const source = readFileSync(join(process.cwd(), 'browser-extension', 'frame-resilient.js'), 'utf8')
  const calls: Array<{ frameId: number; cmd: string; selector: string }> = []
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    URL,
    sendDomCommand: async () => { throw new Error('frame page bridge unavailable in frame 7') },
    resolveTabId: async (value: number) => value,
    safeError: (error: any) => error?.message || String(error),
    delay: async () => {},
    parseFrameSelector(value: string) {
      const top = /^top-frame::([\s\S]+)$/.exec(value)
      if (top) return { selector: top[1], frameUrl: '', topFrame: true }
      const framed = /^frame-url\(([^)]*)\)::([\s\S]+)$/.exec(value)
      if (!framed) return { selector: value, frameUrl: '', topFrame: false }
      return { selector: framed[2], frameUrl: decodeURIComponent(framed[1]), topFrame: false }
    },
    stableFrameUrl(value: string) {
      const url = new URL(value)
      return `${url.origin}${url.pathname}`
    },
    patrolFrames: async () => [
      { frameId: 0, parentFrameId: -1, url: 'https://portal.test/home' },
      { frameId: 7, parentFrameId: 0, url: 'https://portal.test/workbench?tab=1' },
    ],
    chrome: {
      scripting: {
        executeScript: async (input: any) => {
          const frameId = input.target.frameIds[0]
          const [cmd, selector] = input.args
          calls.push({ frameId, cmd, selector })
          if (cmd === 'count') return [{ result: { ok: true, count: countByFrame[frameId] || 0 } }]
          if (cmd === 'click') return [{ result: { ok: true, tag: 'a', text: '我的工作台' } }]
          throw new Error(`unexpected ${cmd}`)
        },
      },
    },
  })
  vm.runInContext(source, context)
  return { context, calls }
}

describe('resilient MAIN-world DOM recovery', () => {
  it('clicks the unique target in the requested content frame when the content bridge is unavailable', async () => {
    const { context, calls } = loadHarness({ 7: 1 })
    const selector = 'frame-url(https%3A%2F%2Fportal.test%2Fworkbench)::ul > li:nth-of-type(5) > a'
    const value = await vm.runInContext(`sendDomCommand('click', { tabId: 1, selector: ${JSON.stringify(selector)} })`, context)

    expect(value.ok).toBe(true)
    expect(value.transport).toBe('main-world-scripting-fallback')
    expect(calls).toEqual([
      { frameId: 7, cmd: 'count', selector: 'ul > li:nth-of-type(5) > a' },
      { frameId: 7, cmd: 'click', selector: 'ul > li:nth-of-type(5) > a' },
    ])
  })

  it('keeps top-frame qualified actions in the top document', async () => {
    const { context, calls } = loadHarness({ 0: 1, 7: 1 })
    const value = await vm.runInContext(`sendDomCommand('click', { tabId: 1, selector: 'top-frame::#workbench' })`, context)

    expect(value.ok).toBe(true)
    expect(calls).toEqual([
      { frameId: 0, cmd: 'count', selector: '#workbench' },
      { frameId: 0, cmd: 'click', selector: '#workbench' },
    ])
  })

  it('refuses an unqualified selector that is visible in more than one frame', async () => {
    const { context, calls } = loadHarness({ 0: 1, 7: 1 })
    await expect(vm.runInContext(`sendDomCommand('click', { tabId: 1, selector: 'a.menu' })`, context))
      .rejects.toThrow(/ambiguous selector matched 2 visible elements/i)
    expect(calls.filter(item => item.cmd === 'click')).toHaveLength(0)
  })

  it('loads after the ordinary frame-aware bridge', () => {
    const entry = readFileSync(join(process.cwd(), 'browser-extension', 'background-entry.js'), 'utf8')
    expect(entry.indexOf("importScripts('frame-support.js')")).toBeGreaterThanOrEqual(0)
    expect(entry.indexOf("importScripts('frame-resilient.js')")).toBeGreaterThan(entry.indexOf("importScripts('frame-support.js')"))
  })
})
