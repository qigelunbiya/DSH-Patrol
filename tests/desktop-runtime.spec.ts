import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WindowsDesktopDriver } from '../desktop-runtime/windows-driver.js'

describe('Desktop Automation runtime foundation', () => {
  it('exposes an explicit unrestricted Windows desktop strategy without affecting non-Windows CI', () => {
    const driver = new WindowsDesktopDriver()
    const status = driver.status()
    expect(status.permissionMode).toBe('unrestricted')
    expect(status.strategy).toEqual(['uia', 'keyboard', 'ocr', 'coordinates'])
    expect(status.supported).toBe(process.platform === 'win32')
  })

  it('ships application knowledge guides including the first WeChat workflow', async () => {
    const driver = new WindowsDesktopDriver()
    const guides = await driver.listGuides(undefined)
    expect(guides.guides).toContain('微信')
    expect(guides.guides).toContain('WPS')
    expect(guides.guides).toContain('百度网盘')

    const wechat = await driver.readGuide('微信', undefined)
    expect(wechat.content).toContain('Ctrl+F')
    expect(wechat.content).toContain('desktop_snapshot')
    expect(wechat.content).toContain('desktop_ocr')
    expect(wechat.content).toContain('${artifact:last-screenshot}')
  })

  it('registers UIA, keyboard, OCR, coordinate, clipboard, message-enabling and delete primitives', () => {
    const source = readFileSync(join(process.cwd(), 'desktop-runtime', 'tools-plugin.js'), 'utf8')
    for (const tool of [
      'desktop_list_windows',
      'desktop_activate_window',
      'desktop_snapshot',
      'desktop_click_target',
      'desktop_click_coordinates',
      'desktop_type_text',
      'desktop_hotkey',
      'desktop_screenshot',
      'desktop_ocr',
      'desktop_set_clipboard_files',
      'desktop_paste',
      'desktop_delete_path',
      'desktop_read_app_guide',
    ]) {
      expect(source).toContain(`name: '${tool}'`)
    }
    expect(source).toContain('permission policy is intentionally unrestricted')
  })
})
