import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findUiaTargetMatches, normalizeOcrObservations, WindowsDesktopDriver } from '../desktop-runtime/windows-driver.js'

describe('Desktop Automation runtime foundation', () => {
  it('exposes an explicit unrestricted Windows desktop strategy without affecting non-Windows CI', async () => {
    const driver = new WindowsDesktopDriver()
    if (process.platform === 'win32') {
      driver.run = async action => action === 'list-windows'
        ? { ok: true, windows: [{ title: 'fixture' }] }
        : { ok: true }
    }
    const status = await driver.status()
    expect(status.permissionMode).toBe('unrestricted')
    expect(status.strategy).toEqual(['uia', 'keyboard', 'ocr', 'coordinates'])
    expect(status.supported).toBe(process.platform === 'win32')
    expect(status.backendReachable).toBe(process.platform === 'win32')
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

  it('matches safe non-password UIA values and keeps password values out of snapshots', () => {
    const matches = findUiaTargetMatches([
      { name: '', automationId: '', controlType: 'Edit', className: 'MessageInput', isPassword: false, value: 'DSH Patrol 测试' },
      { name: '', automationId: '', controlType: 'Edit', className: 'PasswordBox', isPassword: true, value: null },
    ], {
      controlType: 'Edit',
      value: 'DSH Patrol',
      match: 'contains',
    })

    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({ className: 'MessageInput', value: 'DSH Patrol 测试' })

    const source = readFileSync(join(process.cwd(), 'desktop-runtime', 'windows-desktop.ps1'), 'utf8')
    expect(source).toContain('$isPassword = [bool]$current.IsPassword')
    expect(source).toContain('if (-not $isPassword)')
    expect(source).toContain('ValuePattern')
  })

  it('waits for semantic desktop targets through UIA first and OCR fallback second', async () => {
    const driver = new WindowsDesktopDriver()
    const calls: string[] = []
    driver.run = async (action: string) => {
      calls.push(action)
      if (action === 'activate-window') return { ok: true }
      if (action === 'snapshot') {
        return {
          ok: true,
          window: { title: '微信' },
          elements: [{ name: '搜索', automationId: 'SearchBox', controlType: 'Edit', className: 'SearchEdit' }],
        }
      }
      throw new Error(`unexpected action ${action}`)
    }

    const uia = await driver.waitForTarget({
      source: 'auto',
      processName: 'WeChat',
      name: '搜索',
      controlType: 'Edit',
      timeoutMs: 1000,
    })
    expect(uia).toMatchObject({
      ok: true,
      method: 'uia',
      matchCount: 1,
      target: { name: '搜索', controlType: 'Edit' },
    })
    expect(calls).toEqual(['activate-window', 'snapshot'])

    calls.length = 0
    driver.run = async (action: string) => {
      calls.push(action)
      if (action === 'activate-window') return { ok: true }
      if (action === 'snapshot') return { ok: true, window: { title: '微信' }, elements: [] }
      throw new Error(`unexpected action ${action}`)
    }
    driver.ocr = async () => ({
      ok: true,
      status: 'recognized',
      lines: [{ text: '测试联系人', center: { x: 320, y: 280 } }],
      screenshotPath: 'current.png',
      screenshotBounds: { x: 0, y: 0, width: 1000, height: 800 },
      languagesTried: ['zh-CN'],
    })

    const ocr = await driver.waitForTarget({
      source: 'auto',
      processName: 'WeChat',
      text: '测试联系人',
      timeoutMs: 1000,
    })
    expect(ocr).toMatchObject({
      ok: true,
      method: 'ocr',
      matchCount: 1,
      target: { text: '测试联系人', center: { x: 320, y: 280 } },
    })
    expect(calls).toEqual(['activate-window', 'snapshot'])
  })

  it('clicks one unique CURRENT OCR text match and rejects ambiguity', async () => {
    const driver = new WindowsDesktopDriver()
    const clicks: any[] = []
    driver.ocr = async () => ({
      ok: true,
      status: 'recognized',
      lines: [
        { text: '测试联系人', center: { x: 420, y: 310 } },
        { text: '其他联系人', center: { x: 420, y: 360 } },
      ],
      screenshotPath: 'current.png',
      screenshotBounds: { x: 0, y: 0, width: 1000, height: 800 },
      languagesTried: ['zh-CN'],
    })
    driver.run = async (action: string, args: any) => {
      clicks.push({ action, args })
      return { ok: true }
    }

    const result = await driver.clickOcrText({ text: '测试联系人', match: 'exact' })
    expect(result).toMatchObject({
      ok: true,
      method: 'ocr-line-center',
      query: '测试联系人',
      target: { text: '测试联系人', center: { x: 420, y: 310 } },
    })
    expect(clicks).toEqual([{
      action: 'click-coordinates',
      args: { x: 420, y: 310, button: 'left' },
    }])

    driver.ocr = async () => ({
      ok: true,
      status: 'recognized',
      lines: [
        { text: '测试联系人', center: { x: 420, y: 310 } },
        { text: '测试联系人', center: { x: 420, y: 500 } },
      ],
    })
    await expect(driver.clickOcrText({ text: '测试联系人' })).rejects.toThrow(/ambiguous \(2 matches\)/i)
  })

  it('keeps the Windows PowerShell 5.1 backend ASCII-only so BOM-less checkout encoding cannot corrupt parser tokens', () => {
    const source = readFileSync(join(process.cwd(), 'desktop-runtime', 'windows-desktop.ps1'), 'utf8')
    expect(/[^\x00-\x7F]/.test(source)).toBe(false)
    expect(source).toContain("$rawValue.Substring(0, 2000) + '...'")
  })

  it('reports a failed real backend probe instead of claiming Desktop Automation is healthy', async () => {
    const driver = new WindowsDesktopDriver()
    Object.defineProperty(driver, 'supported', { get: () => true })
    driver.run = async () => { throw new Error('ParserError: Unexpected token') }

    const status = await driver.status()
    expect(status.ok).toBe(false)
    expect(status.backendReachable).toBe(false)
    expect(status.error).toMatch(/ParserError/)
  })

  it('does not shadow PowerShell automatic $args with desktop request payloads', () => {
    const source = readFileSync(join(process.cwd(), 'desktop-runtime', 'windows-desktop.ps1'), 'utf8')
    expect(source).not.toMatch(/\$args\b/)
    expect(source).toContain('$request = Decode-Payload $Payload')
  })

  it('registers UIA, keyboard, OCR, coordinate, clipboard, message-enabling and delete primitives', () => {
    const source = readFileSync(join(process.cwd(), 'desktop-runtime', 'tools-plugin.js'), 'utf8')
    for (const tool of [
      'desktop_list_windows',
      'desktop_activate_window',
      'desktop_snapshot',
      'desktop_click_target',
      'desktop_click_ocr_text',
      'desktop_click_coordinates',
      'desktop_wait_for_target',
      'desktop_type_text',
      'desktop_type_target',
      'desktop_paste_target',
      'desktop_press_target',
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
