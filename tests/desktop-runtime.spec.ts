import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { normalizeOcrObservations, WindowsDesktopDriver } from '../desktop-runtime/windows-driver.js'

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

  it('converts normalized OCR lines into CURRENT absolute screen coordinates', () => {
    const lines = normalizeOcrObservations([
      {
        language: 'zh-CN',
        result: {
          lines: [
            {
              text: '测试联系人',
              confidence: 1,
              boundingBox: { x: 0.1, y: 0.2, width: 0.4, height: 0.1 },
            },
          ],
        },
      },
      {
        language: 'en-US',
        result: {
          lines: [
            {
              text: '测试联系人',
              confidence: 1,
              boundingBox: { x: 0.101, y: 0.201, width: 0.4, height: 0.1 },
            },
            {
              text: 'Search',
              confidence: 1,
              boundingBox: { x: 0.5, y: 0.05, width: 0.2, height: 0.08 },
            },
          ],
        },
      },
    ], { x: 100, y: 200, width: 1000, height: 800 })

    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({
      text: '测试联系人',
      language: 'zh-CN',
      rect: { x: 200, y: 360, width: 400, height: 80 },
      center: { x: 400, y: 400 },
    })
    expect(lines[1]).toMatchObject({
      text: 'Search',
      rect: { x: 600, y: 240, width: 200, height: 64 },
      center: { x: 700, y: 272 },
    })
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
