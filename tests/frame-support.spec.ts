import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

function loadFrameSupport() {
  const source = readFileSync(join(process.cwd(), 'browser-extension', 'frame-support.js'), 'utf8')
  const calls: Array<{ frameId: number; cmd: string; args: any }> = []
  const context = vm.createContext({
    URL,
    console,
    setTimeout,
    clearTimeout,
    encodeURIComponent,
    decodeURIComponent,
    sendDomCommand: async (cmd: string, args: any) => {
      if (cmd === 'snapshot') {
        return { ok: true, url: 'https://portal.local/', title: 'Portal', elements: [], truncated: false }
      }
      if (cmd === 'readPage') {
        return { ok: true, url: 'https://portal.local/', title: 'Portal', text: 'legacy top', truncated: false }
      }
      throw new Error(`legacy command not expected: ${cmd} ${JSON.stringify(args)}`)
    },
    resolveTabId: async (value: number) => value,
    safeError: (error: any) => error?.message || String(error),
    isTransientPageBridgeError: () => false,
    delay: async () => {},
    chrome: {
      webNavigation: {
        getAllFrames: async () => [
          { frameId: 0, parentFrameId: -1, url: 'https://portal.local/' },
          { frameId: 7, parentFrameId: 0, url: 'https://portal.local/workflow?tab=pending' },
        ],
      },
      tabs: {
        sendMessage: async (_tabId: number, message: any, options: any) => {
          const frameId = options.frameId
          calls.push({ frameId, cmd: message.cmd, args: message.args })
          if (message.cmd === 'readPage') {
            if (frameId === 0) return { ok: true, url: 'https://portal.local/', title: 'Portal', text: 'portal shell', tables: [] }
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
            return { ok: true, count: frameId === 7 ? 1 : 0 }
          }
          if (message.cmd === 'click') return { ok: true, selector: message.args.selector, tag: 'a', text: '防火墙dnat及策略开放的相关数据采集内容优化' }
          if (message.cmd === 'snapshot') return { ok: true, url: '', title: '', elements: [], truncated: false }
          throw new Error(`unexpected frame command ${message.cmd}`)
        },
      },
    },
  })
  vm.runInContext(source, context)
  return { context, calls }
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
