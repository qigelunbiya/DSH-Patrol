import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const source = readFileSync(join(process.cwd(), 'browser-extension', 'window-visibility.js'), 'utf8')

function wrap(
  base: (cmd: string, args?: any) => Promise<any>,
  chrome: any,
  resolveTabId: (tabId?: number) => Promise<number> = async tabId => tabId ?? 17,
) {
  return new Function(
    'handleCommand',
    'resolveTabId',
    'chrome',
    `${source}\nreturn handleCommand`,
  )(base, resolveTabId, chrome) as typeof base
}

describe('managed Patrol window visibility extension command', () => {
  it('moves the current headful window off-screen for background patrols', async () => {
    const update = vi.fn(async () => ({}))
    const command = wrap(vi.fn(async () => ({ ok: true })), {
      tabs: { get: vi.fn(async () => ({ windowId: 9 })) },
      windows: { update },
    })

    await expect(command('setWindowVisibility', { visible: false, tabId: 4 }))
      .resolves.toEqual({ ok: true, visible: false, windowId: 9 })

    expect(update.mock.calls).toEqual([
      [9, { state: 'normal' }],
      [9, { left: -32000, top: -32000, width: 1440, height: 900, focused: false }],
    ])
  })

  it('restores and maximizes the same browser window for visible patrols', async () => {
    const update = vi.fn(async () => ({}))
    const command = wrap(vi.fn(async () => ({ ok: true })), {
      tabs: { get: vi.fn(async () => ({ windowId: 12 })) },
      windows: { update },
    })

    await expect(command('setWindowVisibility', { visible: true }))
      .resolves.toEqual({ ok: true, visible: true, windowId: 12 })

    expect(update.mock.calls).toEqual([
      [12, { state: 'normal' }],
      [12, { left: 80, top: 60, width: 1280, height: 860, focused: true }],
      [12, { state: 'maximized', focused: true }],
    ])
  })

  it('delegates every unrelated browser command unchanged', async () => {
    const base = vi.fn(async (_cmd: string, args: any) => ({ ok: true, args }))
    const command = wrap(base, { tabs: {}, windows: {} })

    await expect(command('snapshot', { maxElements: 20 })).resolves.toEqual({
      ok: true,
      args: { maxElements: 20 },
    })
    expect(base).toHaveBeenCalledTimes(1)
    expect(base).toHaveBeenCalledWith('snapshot', { maxElements: 20 })
  })
})
