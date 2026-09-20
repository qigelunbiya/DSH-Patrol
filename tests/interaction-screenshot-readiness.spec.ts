import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const interactionPath = fileURLToPath(new URL('../browser-extension/interaction-hardening.js', import.meta.url))

async function loadInteraction(overrides: Record<string, unknown> = {}) {
  const source = await readFile(interactionPath, 'utf8')
  const sandbox: Record<string, any> = {
    sendDomCommand: async () => ({ ok: true }),
    handleCommand: async () => ({ ok: true }),
    resolveTabId: async (tabId: number | undefined) => tabId ?? 7,
    tabInfo: (tab: any) => ({ ...tab }),
    safeError: (error: unknown) => error instanceof Error ? error.message : String(error),
    parseFrameSelector: (selector: string) => ({ selector, topFrame: true }),
    patrolFrames: async () => [],
    stableFrameUrl: (value: string) => value,
    setTimeout: (callback: () => void) => { callback(); return 0 },
    clearTimeout: () => {},
    chrome: {
      tabs: {
        get: async () => ({ id: 7, windowId: 2, status: 'complete', url: 'https://example.test/' }),
        update: async (id: number) => ({ id, windowId: 2, status: 'complete', url: 'https://example.test/' }),
        captureVisibleTab: async () => 'data:image/png;base64,AAAA',
      },
      scripting: {},
    },
    console,
    ...overrides,
  }
  vm.runInNewContext(source, sandbox, { filename: 'interaction-hardening.js' })
  return sandbox
}

describe('Patrol screenshot tab readiness', () => {
  it('binds a visual click to the exact CURRENT screenshot viewport and consumes the frame', async () => {
    let clickedArgs: any[] | undefined
    const viewport = {
      urlIdentity: 'https://example.test/video/1',
      width: 1280,
      height: 720,
      offsetLeft: 0,
      offsetTop: 0,
      scale: 1,
      scrollX: 0,
      scrollY: 500,
    }
    const scripting = {
      async executeScript(request: any) {
        if (request.func?.name === 'interactionMainWorldViewportState') {
          return [{ result: { ...viewport } }]
        }
        if (request.func?.name === 'interactionMainWorldVisualClick') {
          clickedArgs = request.args
          return [{
            result: {
              ok: true,
              selector: '.video-like',
              tag: 'div',
              role: 'button',
              text: '5743',
              title: '点赞',
              ariaLabel: '点赞',
              id: 'like-button',
              className: 'video-like active',
              targetStateChanged: true,
              stateEvidence: 'clicked visual target DOM state changed',
            },
          }]
        }
        throw new Error(`unexpected executeScript function ${request.func?.name || 'anonymous'}`)
      },
    }
    const tabs = {
      get: async () => ({ id: 7, windowId: 2, status: 'complete', url: 'https://example.test/video/1' }),
      update: async (id: number) => ({ id, windowId: 2, status: 'complete', url: 'https://example.test/video/1' }),
      captureVisibleTab: async () => 'data:image/png;base64,AAAA',
    }
    const sandbox = await loadInteraction({ chrome: { tabs, scripting } })

    const shot = await sandbox.handleCommand('screenshot', { tabId: 7 })
    expect(shot.visualFrameId).toMatch(/^browser-visual-/)
    expect(shot).toMatchObject({
      urlIdentity: 'https://example.test/video/1',
      viewportWidth: 1280,
      viewportHeight: 720,
      viewportScale: 1,
      scrollX: 0,
      scrollY: 500,
    })

    const clicked = await sandbox.handleCommand('visualClick', {
      tabId: 7,
      frameId: shot.visualFrameId,
      xRatio: 0.2,
      yRatio: 0.8,
      expectedTitle: '点赞',
      expectedAriaLabel: '点赞',
    })
    expect(clicked).toMatchObject({
      ok: true,
      transport: 'bound-current-visual-frame+synthetic-main-world',
      selectorHint: 'top-frame::.video-like',
      targetTag: 'div',
      targetRole: 'button',
      targetText: '5743',
      targetTitle: '点赞',
      targetAriaLabel: '点赞',
      targetId: 'like-button',
      targetClassName: 'video-like active',
      targetStateChanged: true,
    })
    expect(clickedArgs?.[0]).toBeCloseTo(256)
    expect(clickedArgs?.[1]).toBeCloseTo(576)
    expect(clickedArgs?.[4]).toBe('点赞')
    expect(clickedArgs?.[5]).toBe('点赞')

    await expect(sandbox.handleCommand('visualClick', {
      tabId: 7,
      frameId: shot.visualFrameId,
      xRatio: 0.2,
      yRatio: 0.8,
    })).rejects.toThrow(/stale or unavailable/)
  })

  it('prefers a trusted native mouse event for screenshot-bound visual clicks when chrome.debugger is available', async () => {
    const viewport = {
      urlIdentity: 'https://example.test/video/1',
      width: 1000,
      height: 800,
      offsetLeft: 0,
      offsetTop: 0,
      scale: 1,
      scrollX: 0,
      scrollY: 200,
    }
    const debuggerCalls: Array<{ method: string; params: any }> = []
    const scripting = {
      async executeScript(request: any) {
        if (request.func?.name === 'interactionMainWorldViewportState') return [{ result: { ...viewport } }]
        if (request.func?.name === 'interactionMainWorldVisualClick') {
          expect(request.args?.[6]).toBe(true)
          return [{
            result: {
              ok: true,
              selector: 'div[title="点赞（Q）"]',
              tag: 'div',
              role: '',
              text: '5.8万',
              title: '点赞（Q）',
              ariaLabel: '',
              id: '',
              className: 'video-like',
              targetStateChanged: false,
              stateEvidence: '',
            },
          }]
        }
        throw new Error(`unexpected executeScript function ${request.func?.name || 'anonymous'}`)
      },
    }
    const tabs = {
      get: async () => ({ id: 7, windowId: 2, status: 'complete', url: 'https://example.test/video/1' }),
      update: async (id: number) => ({ id, windowId: 2, status: 'complete', url: 'https://example.test/video/1' }),
      captureVisibleTab: async () => 'data:image/png;base64,AAAA',
    }
    const debuggerApi = {
      async attach() {},
      async sendCommand(_target: any, method: string, params: any) { debuggerCalls.push({ method, params }) },
      async detach() {},
    }
    const sandbox = await loadInteraction({ chrome: { tabs, scripting, debugger: debuggerApi } })
    const shot = await sandbox.handleCommand('screenshot', { tabId: 7 })
    const clicked = await sandbox.handleCommand('visualClick', {
      tabId: 7,
      frameId: shot.visualFrameId,
      xRatio: 0.2,
      yRatio: 0.75,
    })
    expect(clicked.transport).toContain('trusted-native-mouse')
    expect(clicked.selectorHint).toBe('top-frame::div[title="点赞（Q）"]')
    expect(debuggerCalls.map(call => call.method)).toEqual([
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
    ])
    expect(debuggerCalls[1]?.params).toMatchObject({ type: 'mousePressed', x: 200, y: 600, button: 'left' })
  })

  it('waits for a newly opened blank/loading tab to obtain an HTTP URL before capture', async () => {
    let getCalls = 0
    let capturedWindow: number | undefined
    const tabs = {
      get: async () => {
        getCalls += 1
        if (getCalls < 3) return { id: 7, windowId: 2, status: 'loading', url: '' }
        return { id: 7, windowId: 2, status: 'complete', url: 'https://example.test/workorder/1' }
      },
      update: async (id: number) => ({ id, windowId: 2, status: 'complete', url: 'https://example.test/workorder/1' }),
      captureVisibleTab: async (windowId: number) => {
        capturedWindow = windowId
        return 'data:image/png;base64,AAAA'
      },
    }
    const sandbox = await loadInteraction({ chrome: { tabs, scripting: {} } })

    const value = await sandbox.handleCommand('screenshot', { tabId: 7 })

    expect(getCalls).toBe(3)
    expect(capturedWindow).toBe(2)
    expect(value.ok).toBe(true)
    expect(value.bytes).toBeGreaterThan(0)
  })
})
