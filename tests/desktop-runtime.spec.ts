import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { filterOcrMatchesByRegion, findOcrTextMatches, findUiaTargetMatches, normalizeOcrObservations, WindowsDesktopDriver } from '../desktop-runtime/windows-driver.js'
import { PATROL_DESKTOP_PROMPT } from '../src/desktop-prompt.js'

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
    expect(status.strategy).toEqual(['vision', 'keyboard', 'ocr', 'uia', 'visual-point', 'coordinates'])
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
    expect(wechat.content).toContain('目标聊天确认')
    expect(wechat.content).toContain('source=ocr')
    expect(wechat.content).toContain('scope=active-window')
    expect(wechat.content).toContain('minXRatio=0.33')
    expect(wechat.content).toContain('captureMethod=print-window')
    expect(wechat.content).toContain('右侧聊天标题区')
    expect(wechat.content).toContain('禁止自动点击“返回上一页”')
    expect(wechat.content).toContain('${artifact:last-screenshot}')
  })

  it('captures selected windows from their own HWND surface before screen-copy fallback', () => {
    const source = readFileSync(join(process.cwd(), 'desktop-runtime', 'windows-desktop.ps1'), 'utf8')
    const capture = source.slice(source.indexOf('function Capture-Screenshot'), source.indexOf('function Resolve-AppLaunchSpec'))
    expect(source).toContain('PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags)')
    expect(capture).toContain('Activate-Window $process')
    expect(capture).toContain("PrintWindow([IntPtr]$process.MainWindowHandle, $hdc, 2)")
    expect(capture.indexOf('PrintWindow([IntPtr]$process.MainWindowHandle')).toBeLessThan(capture.indexOf('$graphics.CopyFromScreen'))
    expect(capture).toContain("captureMethod='print-window'")
    expect(capture).toContain("captureMethod='screen'")
    const activation = source.slice(source.indexOf('function Activate-Window'), source.indexOf('function Get-Root'))
    expect(activation).toContain('GetForegroundWindow()')
    expect(activation).toContain('if ($foreground -eq $target) { return }')
    expect(activation).toContain('failed to verify foreground desktop window')
  })

  it('requires Patrol desktop flows to record business actions and keeps WeChat OCR window-scoped', () => {
    expect(PATROL_DESKTOP_PROMPT).toMatch(/成功业务动作必须改用 patrol_desktop_action/)
    expect(PATROL_DESKTOP_PROMPT).toMatch(/不能一边显示“巡检流程”一边只调用 raw desktop_\*/)
    expect(PATROL_DESKTOP_PROMPT).toMatch(/scope=active-window/)
    expect(PATROL_DESKTOP_PROMPT).toMatch(/minXRatio=0\.33/)
    expect(PATROL_DESKTOP_PROMPT).toMatch(/captureMethod=print-window/)
    expect(PATROL_DESKTOP_PROMPT).toMatch(/右侧聊天标题区域/)
    expect(PATROL_DESKTOP_PROMPT).toMatch(/禁止再次点联系人/)
    expect(PATROL_DESKTOP_PROMPT).toMatch(/只有 desktop_list_windows 明确确认微信窗口(?:已经)?不存在时才允许重新 launch/)
  })

  it('makes desktop application patrol visual-first and provides a safe window-relative visual click primitive', () => {
    expect(PATROL_DESKTOP_PROMPT).toMatch(/视觉模型优先/)
    expect(PATROL_DESKTOP_PROMPT).toMatch(/desktop_screenshot.*read_image/)
    expect(PATROL_DESKTOP_PROMPT).toMatch(/Windows OCR 只负责文字提取\/几何精修/)
    expect(PATROL_DESKTOP_PROMPT).toMatch(/desktop_click_visual_point/)
    expect(PATROL_DESKTOP_PROMPT).toMatch(/Desktop XY\/1000/)
    expect(PATROL_DESKTOP_PROMPT).toMatch(/desktop_preview_visual_point/)
    expect(PATROL_DESKTOP_PROMPT).toMatch(/绿色十字/)
    expect(PATROL_DESKTOP_PROMPT).toMatch(/检查更新.*关于我们/)
    expect(PATROL_DESKTOP_PROMPT).toMatch(/绝对禁止把 read_image 看到的.*裁剪图像素直接传给 desktop_click_coordinates/)
    expect(PATROL_DESKTOP_PROMPT).toMatch(/重新激活并验证.*同一个 HWND/)
    expect(PATROL_DESKTOP_PROMPT).toMatch(/局部真实像素裁剪/)

    const tools = readFileSync(join(process.cwd(), 'desktop-runtime', 'tools-plugin.js'), 'utf8')
    expect(tools).toContain("name: 'desktop_preview_visual_point'")
    expect(tools).toContain("name: 'desktop_click_visual_point'")
    expect(tools).toContain('xRatio: num')
    expect(tools).toContain('yRatio: num')
    expect(tools).toContain('previewId: str')
    expect(tools).toContain('magnified local crop')
    expect(tools).toContain('EXACT full-frame physical point')
    expect(tools).toContain('Never feed screenshot-local pixels from read_image')

    const backend = readFileSync(join(process.cwd(), 'desktop-runtime', 'windows-desktop.ps1'), 'utf8')
    expect(backend).toContain("'click-visual-point' {")
    expect(backend).toContain("method='bound-window-visual-point'")
    expect(backend).toContain('top-right window-control zone')
    expect(backend).toContain('frameHwnd')
    expect(backend).toContain('window bounds changed after screenshot')
    expect(backend).toContain('Resolve-Window $request $true')
    expect(backend).toContain('function Write-VisualGuideImage')
    expect(backend).toContain('function Write-VisualPointZoomImage')
    expect(backend).toContain("'annotate-visual-guide' {")
    expect(backend).toContain('visual click foreground mismatch')
    expect(backend).toContain('Activate-Window $process')
    expect(backend).toContain('coordinateGridUnits=1000')
    expect(backend).toContain('markXRatio')
    expect(backend).toContain('GetVisibleTopLevelWindows')
    expect(backend).toContain('EnumWindows')
    expect(backend).toContain('QueryFullProcessImageNameW')
    expect(backend).toContain('GetProcessName')
    expect(backend).toContain("rectSource = 'enum-windows-get-window-rect'")
    expect(backend).toContain('[System.Windows.Forms.Cursor]::Position')
    expect(backend).toContain('visual cursor calibration mismatch')
    expect(backend).toContain("transport = 'verified-cursor-mouse-event'")
  })

  it('binds model-vision clicks to the exact full-window screenshot frame and consumes that frame', async () => {
    const driver = new WindowsDesktopDriver()
    driver.screenshot = async (args: any) => {
      expect(args.captureMethod).toBe('screen')
      expect(args.scope).toBe('active-window')
      return {
        ok: true,
        path: 'blue-letter.png',
        scope: 'active-window',
        captureMethod: 'screen',
        x: 100,
        y: 60,
        width: 1000,
        height: 700,
        window: {
          hwnd: 4242,
          processName: 'LxMainNew',
          title: 'blue-letter',
          rect: { x: 100, y: 60, width: 1000, height: 700 },
        },
      }
    }

    const shot = await driver.visualScreenshot({ processName: 'LxMainNew', captureMethod: 'print-window' })
    expect(shot.frameId).toMatch(/^visual-/)
    expect(shot.visualFrame).toMatchObject({
      hwnd: 4242,
      rect: { x: 100, y: 60, width: 1000, height: 700 },
      coordinateSpace: 'physical-screen-top-level-window',
    })

    const calls: any[] = []
    driver.run = async (action: string, args: any) => {
      calls.push({ action, args })
      return { ok: true, method: 'bound-window-visual-point', x: 600, y: 410 }
    }
    const clicked = await driver.clickVisualPoint({
      processName: 'LxMainNew',
      frameId: shot.frameId,
      xRatio: 0.5,
      yRatio: 0.5,
    })
    expect(clicked).toMatchObject({
      frameId: shot.frameId,
      screenshotPath: 'blue-letter.png',
      frameBounds: { x: 100, y: 60, width: 1000, height: 700 },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      action: 'click-visual-point',
      args: {
        hwnd: 4242,
        frameHwnd: 4242,
        frameX: 100,
        frameY: 60,
        frameWidth: 1000,
        frameHeight: 700,
      },
    })
    await expect(driver.clickVisualPoint({
      processName: 'LxMainNew',
      frameId: shot.frameId,
      xRatio: 0.5,
      yRatio: 0.5,
    })).rejects.toThrow(/unavailable or already consumed/)
  })

  it('previews a desktop visual point on the same frame without consuming or clicking it', async () => {
    const driver = new WindowsDesktopDriver()
    const frame = {
      frameId: 'visual-preview-test',
      createdAt: Date.now(),
      path: 'guided.png',
      rawPath: 'raw.png',
      hwnd: 4242,
      processName: 'LxMainNew',
      title: 'BlueLetter',
      rect: { x: 100, y: 60, width: 1000, height: 700 },
    }
    driver.visualFrames.set(frame.frameId, frame)
    driver.lastVisualFrameId = frame.frameId
    const calls: any[] = []
    driver.run = async (action: string, args: any) => {
      calls.push({ action, args })
      if (action === 'annotate-visual-guide') return { ok: true, path: 'preview.png', coordinateGridUnits: 1000 }
      if (action === 'click-visual-point') return { ok: true, method: 'bound-window-visual-point', inputTransport: 'verified-cursor-mouse-event', x: 842, y: 490 }
      throw new Error(`unexpected action ${action}`)
    }

    const preview = await driver.previewVisualPoint({
      processName: 'LxMainNew',
      frameId: frame.frameId,
      xRatio: 0.742,
      yRatio: 0.615,
    })

    expect(preview).toMatchObject({
      previewId: expect.stringMatching(/^desktop-preview-/),
      frameId: frame.frameId,
      xRatio: 0.742,
      yRatio: 0.615,
      previewPath: 'preview.png',
      physicalClickDispatched: false,
      coordinateGridUnits: 1000,
    })
    expect(calls).toEqual([{
      action: 'annotate-visual-guide',
      args: {
        sourcePath: 'raw.png',
        path: expect.stringContaining('-preview-'),
        markXRatio: 0.742,
        markYRatio: 0.615,
        zoomPreview: true,
      },
    }])
    expect(driver.visualFrames.has(frame.frameId)).toBe(true)
    expect(driver.visualPreviews.has(preview.previewId)).toBe(true)
    expect(driver.lastVisualFrameId).toBe(frame.frameId)

    const clicked = await driver.clickVisualPoint({
      processName: 'LxMainNew',
      previewId: preview.previewId,
    })
    expect(clicked).toMatchObject({
      previewId: preview.previewId,
      previewBound: true,
      frameId: frame.frameId,
      xRatio: 0.742,
      yRatio: 0.615,
      inputTransport: 'verified-cursor-mouse-event',
    })
    expect(calls[1]).toMatchObject({
      action: 'click-visual-point',
      args: {
        xRatio: 0.742,
        yRatio: 0.615,
        frameHwnd: 4242,
        frameX: 100,
        frameY: 60,
        frameWidth: 1000,
        frameHeight: 700,
      },
    })
    expect(driver.visualFrames.has(frame.frameId)).toBe(false)
    expect(driver.visualPreviews.has(preview.previewId)).toBe(false)
  })

  it('uses DPI-aware DWM visible bounds and refuses partial active-window screen copies', () => {
    const source = readFileSync(join(process.cwd(), 'desktop-runtime', 'windows-desktop.ps1'), 'utf8')
    expect(source).toContain('SetProcessDpiAwarenessContext')
    expect(source).toContain('DwmGetWindowAttribute')
    expect(source).toContain('dwm-extended-frame')
    expect(source).toContain('target window is not fully inside the virtual screen')
    const tools = readFileSync(join(process.cwd(), 'desktop-runtime', 'tools-plugin.js'), 'utf8')
    expect(tools).toContain('deliberately does NOT use PrintWindow')
    expect(tools).toContain('driver.visualScreenshot')
    expect(tools).toContain('driver.clickVisualPoint')
    expect(tools).toContain('frameId: str')
    expect(PATROL_DESKTOP_PROMPT).toMatch(/PrintWindow 返回成功但只画出一部分 UI/)
    expect(PATROL_DESKTOP_PROMPT).toMatch(/frameId、HWND、rect 与 desktop_click_visual_point 强绑定/)
    expect(PATROL_DESKTOP_PROMPT).toMatch(/不能把 Ctrl\+F .*通用桌面能力/)
  })

  it('matches OCR text despite recognition-inserted whitespace', () => {
    const lines = [
      { text: '文 件 传 输 助 手', center: { x: 300, y: 240 } },
      { text: '其他联系人', center: { x: 300, y: 300 } },
    ]
    expect(findOcrTextMatches(lines, { text: '文件传输助手', match: 'exact' })).toEqual([lines[0]])
    expect(findOcrTextMatches(lines, { text: '传输助手', match: 'contains' })).toEqual([lines[0]])
  })

  it('filters duplicate OCR text by CURRENT window-relative region for chat-title verification', () => {
    const lines = [
      { text: '文件传输助手', center: { x: 180, y: 170 } },
      { text: '文件传输助手', center: { x: 560, y: 90 } },
      { text: '其他内容', center: { x: 700, y: 400 } },
    ]
    const filtered = filterOcrMatchesByRegion(lines, { x: 0, y: 0, width: 1000, height: 800 }, {
      minXRatio: 0.33,
      maxXRatio: 0.90,
      minYRatio: 0,
      maxYRatio: 0.20,
    })
    expect(filtered).toEqual([lines[1]])
    expect(() => filterOcrMatchesByRegion(lines, { x: 0, y: 0, width: 1000, height: 800 }, {
      minXRatio: 0.8,
      maxXRatio: 0.2,
    })).toThrow(/minimum ratios/)
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

  it('omits undefined optional OCR wait metadata so tool output remains lossless JSON', async () => {
    const driver = new WindowsDesktopDriver()
    driver.run = async (action: string) => {
      if (action === 'activate-window') return { ok: true }
      throw new Error(`unexpected action ${action}`)
    }
    driver.ocr = async () => ({
      ok: true,
      status: 'recognized',
      lines: [{ text: '文件传输助手', center: { x: 600, y: 80 } }],
      screenshotPath: 'current.png',
      screenshotBounds: { x: 0, y: 0, width: 1000, height: 800 },
      languagesTried: ['zh-CN'],
    })
    const result = await driver.waitForTarget({
      source: 'ocr',
      processName: 'Weixin',
      text: '文件传输助手',
      timeoutMs: 1000,
    })
    expect(Object.hasOwn(result, 'region')).toBe(false)
    expect(Object.hasOwn(result, 'window')).toBe(false)
    expect(Object.hasOwn(result, 'scope')).toBe(false)
    expect(Object.hasOwn(result, 'captureMethod')).toBe(false)
    expect(JSON.parse(JSON.stringify(result))).toEqual(result)
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

  it('resolves friendly installed app names without application-specific hardcoding', () => {
    const source = readFileSync(join(process.cwd(), 'desktop-runtime', 'windows-desktop.ps1'), 'utf8')
    expect(source).toContain('function Resolve-AppLaunchSpec')
    expect(source).toContain('Get-Command -Name $name -CommandType Application')
    expect(source).toContain('App Paths')
    expect(source).toContain("GetFolderPath('StartMenu')")
    expect(source).toContain("GetFolderPath('CommonStartMenu')")
    expect(source).toContain("Filter '*.lnk'")
    expect(source).toContain("mode='shortcut'")
    expect(source).toContain('Get-StartApps')
    expect(source).toContain("throw 'launch-app requires file or app'")
    expect(source).toContain("'resolve-app'")
    expect(source).not.toMatch(/^\s*-or\b/m)
    expect(source).not.toMatch(/WeChat|微信|WPS|百度网盘/)
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
      'desktop_preview_visual_point',
      'desktop_click_visual_point',
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
