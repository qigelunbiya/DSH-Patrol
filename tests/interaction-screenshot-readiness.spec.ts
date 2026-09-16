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
