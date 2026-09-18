// @ts-nocheck
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { apply as applyDesktopTools } from '../desktop-runtime/tools-plugin.js'

describe('desktop agent plane', () => {
  it('registers desktop primitives independently from the browser bridge', () => {
    const definitions = []
    const ctx = {
      logger: { info() {}, warn() {} },
      tools: {
        register(definition) {
          definitions.push(definition)
          return () => {}
        },
      },
      effect(factory) {
        return factory()
      },
    }

    applyDesktopTools(ctx, { commandTimeoutMs: 1000 })

    const names = definitions.map(definition => definition.name)
    expect(names).toContain('desktop_status')
    expect(names).toContain('desktop_list_windows')
    expect(names).toContain('desktop_snapshot')
    expect(names).toContain('desktop_click_target')
    expect(names).toContain('desktop_wait_for_target')
    expect(names).toContain('desktop_type_target')
    expect(names).toContain('desktop_hotkey')
    expect(names).toContain('desktop_ocr')
    expect(names).toContain('desktop_set_clipboard_files')
    expect(names).toContain('desktop_delete_path')
    expect(names).toContain('desktop_read_app_guide')
    expect(names.some(name => name.startsWith('browser_'))).toBe(false)
  })

  it('reports unsupported rather than trying to drive a desktop on non-Windows hosts', async () => {
    const definitions = []
    const ctx = {
      logger: { info() {}, warn() {} },
      tools: {
        register(definition) {
          definitions.push(definition)
          return () => {}
        },
      },
      effect(factory) {
        return factory()
      },
    }
    applyDesktopTools(ctx, { commandTimeoutMs: 1000 })
    const status = definitions.find(definition => definition.name === 'desktop_status')
    expect(status).toBeDefined()
    const value = await status.execute({}, {})
    expect(value.permissionMode).toBe('unrestricted')
    expect(value.strategy).toEqual(['uia', 'keyboard', 'ocr', 'coordinates'])
    expect(value.supported).toBe(process.platform === 'win32')
  })

  it('is mounted by the Patrol preset without changing the browser-tools row', () => {
    const preset = readFileSync(join(process.cwd(), 'presets', 'patrol', 'agent.cordis.yml'), 'utf8')
    expect(preset).toContain("name: 'dsh-patrol/browser-tools'")
    expect(preset).toContain("name: 'dsh-patrol/desktop-tools'")
    expect(preset).toContain('commandTimeoutMs: 30000')
  })
})
