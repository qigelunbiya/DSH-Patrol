import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

function loadFrameSupport(
  topElements: any[] = [],
  frameList = [
    { frameId: 0, parentFrameId: -1, url: 'https://portal.local/' },
    { frameId: 7, parentFrameId: 0, url: 'https://portal.local/workflow?tab=pending' },
  ],
) {
  const source = readFileSync(join(process.cwd(), 'browser-extension', 'frame-support.js'), 'utf8')
  const calls: Array<{ frameId: number; cmd: string; args: any }> = []
  let inFlight = 0
  let maxInFlight = 0
  const context = vm.createContext({
    URL,
    console,
    setTimeout,
    clearTimeout,
    encodeURIComponent,
    decodeURIComponent,
    sendDomCommand: async (cmd: string, args: any) => {
      if (cmd === 'snapshot') {
        return {
          ok: true,
          url: 'https://portal.local/',
          title: 'Portal',
          elements: topElements.slice(0, Number.isInteger(args?.maxElements) ? args.maxElements : topElements.length),
          truncated: topElements.length > (Number.isInteger(args?.maxElements) ? args.maxElements : topElements.length),
        }
      }
      if (cmd === 'readPage') {
        return { ok: true, url: 'https://portal.local/', title: 'Portal', text: 'legacy top', truncated: false }
      }
      if (cmd === 'count') {
        calls.push({ frameId: 0, cmd, args })
        return { ok: true, count: String(args?.selector || '').includes('li:nth-of-type(5)') ? 1 : 0 }
      }
      if (cmd === 'click') {
        calls.push({ frameId: 0, cmd, args })
        return { ok: true, selector: args.selector, tag: 'a', text: '我的工作台' }
      }
      if (cmd === 'wait') {
        calls.push({ frameId: 0, cmd, args })
        return { ok: true, found: true, selector: args.selector, timeoutMs: args.timeoutMs ?? 10000 }
      }
      throw new Error(`legacy command not expected: ${cmd} ${JSON.stringify(args)}`)
    },
    resolveTabId: async (value: number) => value,
    safeError: (error: any) => error?.message || String(error),
    isTransientPageBridgeError: () => false,
    delay: async () => {},
    chrome: {
      webNavigation: {
        getAllFrames: async () => frameList,
      },
      tabs: {
        sendMessage: async (_tabId: number, message: any, options: any) => {
          const frameId = options.frameId
          calls.push({ frameId, cmd: message.cmd, args: message.args })
          inFlight += 1
          maxInFlight = Math.max(maxInFlight, inFlight)
          try {
          if (message.cmd === 'readPage') {
            if (frameId === 0) return { ok: true, url: 'https://portal.local/', title: 'Portal', text: 'portal shell', tables: [] }
            await new Promise(resolve => setTimeout(resolve, 5))
            return {
              ok: true,
              url: 'https://portal.local/workflow?tab=pending',
              title: 'Pending jobs',
              text: '待办任务列表',
              tables: [{
                id: 'pendingJobGridIdContainer',
                rows: [{
                  cells: [
                    { column: '工单号', value: 'SE20260824170113242' },
                    { column: '工单标题', value: '防火墙dnat及策略开放的相关数据采集内容优化', clickSelector: '#row1 > td:nth-of-type(5) > a' },
                    { column: '提单时间', value: '2026-08-24 17:11:39' },
                  ],
                }],
              }],
            }
          }
          if (message.cmd === 'count') {
            if (message.args.selector === '#target') return { ok: true, count: frameId === 7 ? 1 : 0 }
            if (String(message.args.selector).includes('li:nth-of-type(5)')) return { ok: true, count: frameId === 0 ? 1 : 1 }
            return { ok: true, count: 0 }
          }
          if (message.cmd === 'wait') {
            await new Promise(resolve => setTimeout(resolve, 5))
            return { ok: true, found: true, selector: message.args.selector, timeoutMs: message.args.timeoutMs ?? 10000 }
          }
          if (message.cmd === 'click') return { ok: true, selector: message.args.selector, tag: 'a', text: '防火墙dnat及策略开放的相关数据采集内容优化' }
          if (message.cmd === 'snapshot') {
            return {
              ok: true,
              url: frameId === 7 ? 'https://portal.local/workflow?tab=pending' : '',
              title: '',
              elements: frameId === 7 && topElements.length > 0
                ? [{ tag: 'a', text: '待办待阅工单', selector: '#pending-link' }]
                : [],
              truncated: false,
            }
          }
          throw new Error(`unexpected frame command ${message.cmd}`)
          } finally {
            inFlight -= 1
          }
        },
      },
    },
  })
  vm.runInContext(source, context)
  return { context, calls, get maxInFlight() { return maxInFlight } }
}

describe('frame-aware browser bridge', () => {
  it('puts structured iframe table data into browser_read_page with full unclipped values and durable click selectors', async () => {
    const { context } = loadFrameSupport()
    const value = await vm.runInContext(`sendDomCommand('readPage', { tabId: 1, maxChars: 20000 })`, context)
    expect(value.text).toContain('SE20260824170113242')
    expect(value.text).toContain('2026-08-24 17:11:39')
    expect(value.text).toContain('防火墙dnat及策略开放的相关数据采集内容优化')
    expect(value.text).toContain('frame-url(https%3A%2F%2Fportal.local%2Fworkflow)::#row1 > td:nth-of-type(5) > a')
  })

  it('discovers a unique selector inside a child frame and clicks that frame instead of the top document', async () => {
    const { context, calls } = loadFrameSupport()
    const value = await vm.runInContext(`sendDomCommand('click', { tabId: 1, selector: '#target' })`, context)
    expect(value.ok).toBe(true)
    const click = calls.find(item => item.cmd === 'click')
    expect(click?.frameId).toBe(7)
    expect(click?.args.selector).toBe('#target')
  })

  it('uses the stable top bridge for top-frame qualified selectors and avoids child-frame duplicates', async () => {
    const { context, calls } = loadFrameSupport()
    const selector = 'div:nth-of-type(1) > div > div > div > ul > li:nth-of-type(5) > a'
    const value = await vm.runInContext(`sendDomCommand('click', { tabId: 1, selector: ${JSON.stringify(`top-frame::${selector}`)} })`, context)
    expect(value.ok).toBe(true)
    const click = calls.find(item => item.cmd === 'click')
    expect(click?.frameId).toBe(0)
    expect(click?.args.selector).toBe(selector)
    expect(calls.filter(item => item.cmd === 'count' && item.frameId === 7)).toHaveLength(0)
  })

  it('reserves snapshot capacity for iframe targets when the top document is large', async () => {
    const topElements = Array.from({ length: 500 }, (_, index) => ({
      tag: 'div',
      text: `shell-${index}`,
      selector: `#shell-${index}`,
    }))
    const { context } = loadFrameSupport(topElements)
    const value = await vm.runInContext(`sendDomCommand('snapshot', { tabId: 1, maxElements: 500 })`, context)
    expect(value.elements.some((item: any) => String(item.selector).startsWith('frame-url('))).toBe(true)
    expect(value.elements.length).toBeGreaterThan(475)
    expect(value.elements.length).toBeLessThanOrEqual(500)
  })

  it('probes multiple child frames concurrently while preserving frame-qualified page data', async () => {
    const loaded = loadFrameSupport([], [
      { frameId: 0, parentFrameId: -1, url: 'https://portal.local/' },
      ...Array.from({ length: 6 }, (_, index) => ({
        frameId: index + 7,
        parentFrameId: 0,
        url: `https://portal.local/frame-${index + 1}`,
      })),
    ])
    const value = await vm.runInContext(`sendDomCommand('readPage', { tabId: 1, maxChars: 20000 })`, loaded.context)
    expect(loaded.maxInFlight).toBeGreaterThan(1)
    expect(loaded.maxInFlight).toBeLessThanOrEqual(4)
    expect(value.text).toContain('[Frame 7 - https://portal.local/frame-1]')
    expect(value.text).toContain('[Frame 12 - https://portal.local/frame-6]')
  })

  it('keeps wait probes on the same bounded concurrency budget', async () => {
    const loaded = loadFrameSupport([], [
      { frameId: 0, parentFrameId: -1, url: 'https://portal.local/' },
      ...Array.from({ length: 6 }, (_, index) => ({
        frameId: index + 7,
        parentFrameId: 0,
        url: `https://portal.local/frame-${index + 1}`,
      })),
    ])
    const value = await vm.runInContext(`sendDomCommand('wait', { tabId: 1, selector: '#ready', condition: 'visible', timeoutMs: 100 })`, loaded.context)
    expect(value.found).toBe(true)
    expect(loaded.maxInFlight).toBeLessThanOrEqual(4)
  })
})

describe('frame structured-table extraction primitives', () => {
  it('prefers a cell title over clipped text and resolves jqGrid aria-describedby headers', () => {
    const source = readFileSync(join(process.cwd(), 'browser-extension', 'frame-content.js'), 'utf8')
    const header = { textContent: '工单号', innerText: '工单号' }
    const context = vm.createContext({
      chrome: { runtime: { onMessage: { addListener() {} } } },
      document: { getElementById: (id: string) => id === 'grid_APP_ID' ? header : null },
      HTMLInputElement: class {},
      HTMLTextAreaElement: class {},
      HTMLAnchorElement: class {},
      Node: { ELEMENT_NODE: 1 },
      CSS: { escape: (value: string) => value },
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', cursor: 'default' }),
      window: {},
      setTimeout,
      Promise,
      Event: class {},
      InputEvent: class {},
      KeyboardEvent: class {},
      MouseEvent: class {},
    })
    vm.runInContext(source, context)
    ;(context as any).cell = {
      getAttribute(name: string) {
        if (name === 'title') return 'SE20260824170113242'
        if (name === 'aria-describedby') return 'grid_APP_ID'
        return ''
      },
      textContent: 'SE2...',
      innerText: 'SE2...',
    }
    ;(context as any).table = { querySelectorAll: () => [] }
    expect(vm.runInContext('frameCellValue(cell)', context)).toBe('SE20260824170113242')
    expect(vm.runInContext('frameCellHeader(cell, table, 0)', context)).toBe('工单号')
  })

  it('keeps legacy static scripts top-frame-only and dynamically registers the audited frame bridge', () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'browser-extension', 'manifest.json'), 'utf8'))
    const registration = readFileSync(join(process.cwd(), 'browser-extension', 'frame-registration.js'), 'utf8')
    const entry = readFileSync(join(process.cwd(), 'browser-extension', 'background-entry.js'), 'utf8')
    expect(manifest.permissions).toContain('webNavigation')
    expect(manifest.permissions).toContain('scripting')
    expect(manifest.background.service_worker).toBe('background-entry.js')
    expect(manifest.content_scripts.every((item: any) => item.all_frames !== true)).toBe(true)
    expect(registration).toContain("js: ['frame-content.js']")
    expect(registration).toContain('allFrames: true')
    expect(entry).toContain("importScripts('frame-registration.js')")
  })
})
