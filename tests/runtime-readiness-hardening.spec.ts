import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const hardeningPath = fileURLToPath(new URL('../browser-extension/runtime-readiness-hardening.js', import.meta.url))
const entryPath = fileURLToPath(new URL('../browser-extension/background-entry.js', import.meta.url))

async function loadHardening(overrides: Record<string, unknown> = {}) {
  const source = await readFile(hardeningPath, 'utf8')
  const sandbox: Record<string, any> = {
    handleCommand: async (_cmd: string, _args: unknown) => ({ ok: true }),
    sendDomCommand: async (_cmd: string, _args: unknown) => ({ ok: true }),
    resolveTabId: async (explicit: number | undefined) => explicit ?? 1,
    tabInfo: (tab: any) => ({ ...tab }),
    safeError: (error: unknown) => error instanceof Error ? error.message : String(error),
    delay: async () => {},
    chrome: { tabs: { get: async (tabId: number) => ({ id: tabId, status: 'complete' }) } },
    console,
    ...overrides,
  }
  runInNewContext(source, sandbox, { filename: 'runtime-readiness-hardening.js' })
  return sandbox
}

describe('runtime replay readiness hardening', () => {
  it('is loaded last so it wraps the final browser interaction stack', async () => {
    const entry = await readFile(entryPath, 'utf8')
    const imports = [...entry.matchAll(/importScripts\('([^']+)'\)/g)].map(match => match[1])
    expect(imports.at(-1)).toBe('runtime-readiness-hardening.js')
  })

  it('waits for Chromium tab loading to complete before navigation returns', async () => {
    let getCalls = 0
    const sandbox = await loadHardening({
      handleCommand: async (cmd: string) => {
        expect(cmd).toBe('navigate')
        return { tab: { id: 7, status: 'loading', url: 'https://example.test' } }
      },
      chrome: {
        tabs: {
          get: async () => {
            getCalls += 1
            return getCalls < 3
              ? { id: 7, status: 'loading', url: 'https://example.test' }
              : { id: 7, status: 'complete', url: 'https://example.test', title: 'Ready' }
          },
        },
      },
    })

    const value = await sandbox.handleCommand('navigate', { url: 'https://example.test' })

    expect(getCalls).toBe(3)
    expect(value.tab.status).toBe('complete')
    expect(value.tab.title).toBe('Ready')
  })

  it('retries selector-bound DOM actions when the element is only temporarily unavailable', async () => {
    let calls = 0
    const waits: number[] = []
    const sandbox = await loadHardening({
      sendDomCommand: async () => {
        calls += 1
        if (calls < 3) throw new Error('element not found in any accessible frame: #username')
        return { ok: true, selector: '#username' }
      },
      delay: async (ms: number) => { waits.push(ms) },
    })

    const value = await sandbox.sendDomCommand('type', { selector: '#username', text: 'public-value' })

    expect(value).toEqual({ ok: true, selector: '#username' })
    expect(calls).toBe(3)
    expect(waits).toEqual([150, 350])
  })

  it('does not retry unrelated failures or selector-free commands', async () => {
    let unrelatedCalls = 0
    const unrelated = await loadHardening({
      sendDomCommand: async () => {
        unrelatedCalls += 1
        throw new Error('permission denied')
      },
    })
    await expect(unrelated.sendDomCommand('type', { selector: '#username' })).rejects.toThrow(/permission denied/)
    expect(unrelatedCalls).toBe(1)

    let selectorFreeCalls = 0
    const selectorFree = await loadHardening({
      sendDomCommand: async () => {
        selectorFreeCalls += 1
        throw new Error('element not found in any accessible frame')
      },
    })
    await expect(selectorFree.sendDomCommand('press', { key: 'Enter' })).rejects.toThrow(/element not found/)
    expect(selectorFreeCalls).toBe(1)
  })
})
