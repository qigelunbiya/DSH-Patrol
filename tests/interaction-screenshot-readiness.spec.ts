import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const interactionPath = fileURLToPath(new URL('../browser-extension/interaction-hardening.js', import.meta.url))
const backgroundPath = fileURLToPath(new URL('../browser-extension/background.js', import.meta.url))

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
  it('adopts exactly one child tab opened by an ordinary DOM click without focusing the OS window', async () => {
    let queryCalls = 0
    const updates: Array<{ id: number; info: any }> = []
    const tabs = {
      get: async (id: number) => ({ id, windowId: 2, status: 'complete', url: 'https://example.test/' }),
      query: async () => {
        queryCalls += 1
        if (queryCalls === 1) return [{ id: 7, windowId: 2, active: true, url: 'https://example.test/' }]
        return [
          { id: 7, windowId: 2, active: true, url: 'https://example.test/' },
          { id: 9, windowId: 2, openerTabId: 7, active: false, url: 'https://example.test/video/9' },
        ]
      },
      update: async (id: number, info: any) => {
        updates.push({ id, info })
        return { id, windowId: 2, ...info, url: id === 9 ? 'https://example.test/video/9' : 'https://example.test/' }
      },
      captureVisibleTab: async () => 'data:image/png;base64,AAAA',
    }
    const sandbox = await loadInteraction({ chrome: { tabs, scripting: {} } })
    const clicked = await sandbox.sendDomCommand('click', { tabId: 7, selector: '#video' })

    expect(clicked).toMatchObject({
      ok: true,
      openedTabId: 9,
      openedTabUrl: 'https://example.test/video/9',
    })
    expect(clicked.stateEvidence).toMatch(/opened child tab 9/)
    expect(updates).toContainEqual({ id: 9, info: { active: true } })
  })

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
      visualAuthority: true,
      xRatio: 0.2,
      yRatio: 0.8,
      expectedTitle: '点赞',
      expectedAriaLabel: '点赞',
      targetHint: '点赞按钮',
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
      visualAuthority: true,
      xRatio: 0.2,
      yRatio: 0.8,
      targetHint: '点赞按钮',
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
          const after = debuggerCalls.length > 0
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
              className: after ? 'video-like active' : 'video-like',
              targetStateChanged: false,
              targetFocusedEditable: false,
              stateSignature: after ? 'div|video-like active' : 'div|video-like',
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
      visualAuthority: true,
      xRatio: 0.2,
      yRatio: 0.75,
      targetHint: '点赞按钮',
    })
    expect(clicked.transport).toContain('trusted-native-mouse')
    expect(clicked.selectorHint).toBe('top-frame::div[title="点赞（Q）"]')
    expect(clicked.targetStateChanged).toBe(true)
    expect(clicked.stateEvidence).toMatch(/own DOM state/)
    expect(debuggerCalls.map(call => call.method)).toEqual([
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
    ])
    expect(debuggerCalls[1]?.params).toMatchObject({ type: 'mousePressed', x: 200, y: 600, button: 'left' })
  })

  it('keeps the exact live visual comment point even when a different closed-shadow editor could be semantically resolved', async () => {
    const viewport = {
      urlIdentity: 'https://example.test/video/1',
      width: 1000, height: 800, offsetLeft: 0, offsetTop: 0, scale: 1,
      scrollX: 0, scrollY: 1200,
    }
    const debuggerCalls: Array<{ method: string; params: any }> = []
    const mouseEvents: Array<{ method: string; params: any }> = []
    const scripting = {
      async executeScript(request: any) {
        if (request.func?.name === 'interactionMainWorldViewportState') return [{ result: { ...viewport } }]
        if (request.func?.name === 'interactionMainWorldVisualClick') {
          expect(request.args?.[8]).toBe(true)
          return [{ result: {
            ok: true,
            selector: 'bili-comment-editor',
            replaySelectorSafe: true,
            selectorQuality: 'medium',
            bindingActionable: true,
            bindingSource: 'visual-hit-test-post-click-learning',
            visualAuthority: true,
            tag: 'bili-comment-editor',
            role: '',
            text: 'wifi 连接中……检测到粉丝评论输出电波……',
            stateSignature: mouseEvents.length ? 'focused-host' : 'idle-host',
            targetFocusedEditable: false,
            clickX: request.args?.[0],
            clickY: request.args?.[1],
          } }]
        }
        if (request.func?.name === 'interactionMainWorldFocusedEditor') {
          return [{ result: {
            ok: true,
            focusUsable: mouseEvents.length > 0,
            focusedTag: 'bili-comment-editor',
            focusKind: 'custom-focus-host',
            observedText: '',
          } }]
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
      async sendCommand(_target: any, method: string, params: any) {
        debuggerCalls.push({ method, params })
        if (method === 'Input.dispatchMouseEvent') {
          mouseEvents.push({ method, params })
          return {}
        }
        throw new Error(`live visual authority must not pre-resolve a different DOM target via ${method}`)
      },
      async detach() {},
    }
    const sandbox = await loadInteraction({ chrome: { tabs, scripting, debugger: debuggerApi } })
    const shot = await sandbox.handleCommand('screenshot', { tabId: 7 })
    const clicked = await sandbox.handleCommand('visualClick', {
      tabId: 7,
      frameId: shot.visualFrameId,
      visualAuthority: true,
      xRatio: 0.30,
      yRatio: 0.78,
      targetHint: 'wifi连接中的评论输入框',
    })

    const pressed = mouseEvents.find(item => item.params?.type === 'mousePressed')
    expect(pressed?.params).toMatchObject({ x: 300, y: 624, button: 'left' })
    expect(clicked).toMatchObject({
      ok: true,
      cdpPiercedTarget: false,
      visualAuthority: true,
      visualSnapped: false,
      requestedClickX: 300,
      requestedClickY: 624,
      resolvedClickX: 300,
      resolvedClickY: 624,
      xRatio: 0.30,
      yRatio: 0.78,
      requestedXRatio: 0.30,
      requestedYRatio: 0.78,
      targetFocusedEditable: true,
    })
    expect(debuggerCalls.map(call => call.method)).toEqual([
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
    ])
  })

  it('recovers a newly mounted local Shadow-DOM editor only after the exact visual click', async () => {
    const viewport = {
      urlIdentity: 'https://example.test/video/1',
      width: 1000, height: 800, offsetLeft: 0, offsetTop: 0, scale: 1,
      scrollX: 0, scrollY: 1200,
    }
    let pressedCount = 0
    const pressedPoints: Array<{ x: number; y: number }> = []
    const scripting = {
      async executeScript(request: any) {
        if (request.func?.name === 'interactionMainWorldViewportState') return [{ result: { ...viewport } }]
        if (request.func?.name === 'interactionMainWorldVisualClick') {
          return [{ result: {
            ok: true,
            selector: 'bili-comment-editor',
            replaySelectorSafe: true,
            selectorQuality: 'medium',
            bindingActionable: true,
            bindingSource: 'visual-hit-test-post-click-learning',
            visualAuthority: true,
            tag: 'bili-comment-editor',
            role: '',
            text: '哎哟，不错哦，发条评论吧',
            stateSignature: pressedCount > 0 ? 'activated-host' : 'idle-host',
            targetFocusedEditable: false,
            clickX: request.args?.[0],
            clickY: request.args?.[1],
          } }]
        }
        if (request.func?.name === 'interactionMainWorldFocusedEditor') {
          return [{ result: {
            ok: true,
            focusUsable: pressedCount >= 2,
            focusedTag: pressedCount >= 2 ? 'div' : 'bili-comment-editor',
            focusKind: pressedCount >= 2 ? 'editable' : 'custom-focus-host',
            observedText: '',
          } }]
        }
        throw new Error(`unexpected executeScript function ${request.func?.name || 'anonymous'}`)
      },
    }
    const debuggerApi = {
      async attach() {},
      async sendCommand(_target: any, method: string, params: any) {
        if (method === 'Input.dispatchMouseEvent') {
          if (params?.type === 'mousePressed') {
            pressedCount += 1
            pressedPoints.push({ x: params.x, y: params.y })
          }
          return {}
        }
        if (method === 'DOM.getDocument') {
          return {
            root: {
              nodeName: '#document',
              backendNodeId: 1,
              children: pressedCount >= 1
                ? [{
                    nodeName: 'BILI-COMMENT-EDITOR',
                    backendNodeId: 20,
                    attributes: ['class', 'comment-editor', 'data-placeholder', '哎哟，不错哦，发条评论吧'],
                    shadowRoots: [{
                      nodeName: '#document-fragment',
                      backendNodeId: 21,
                      children: [{
                        nodeName: 'DIV',
                        backendNodeId: 30,
                        attributes: ['contenteditable', 'true', 'role', 'textbox', 'class', 'comment-editor-input'],
                      }],
                    }],
                  }]
                : [],
            },
          }
        }
        if (method === 'DOM.resolveNode' && params.backendNodeId === 30) return { object: { objectId: 'editor-30' } }
        if (method === 'Runtime.callFunctionOn' && params.objectId === 'editor-30') {
          return { result: { value: { left: 280, top: 600, right: 680, bottom: 650, width: 400, height: 50 } } }
        }
        if (method === 'DOM.getNodeForLocation') return { backendNodeId: 30 }
        throw new Error(`unexpected debugger command ${method}`)
      },
      async detach() {},
    }
    const tabs = {
      get: async () => ({ id: 7, windowId: 2, status: 'complete', url: 'https://example.test/video/1' }),
      update: async (id: number) => ({ id, windowId: 2, status: 'complete', url: 'https://example.test/video/1' }),
      captureVisibleTab: async () => 'data:image/png;base64,AAAA',
    }
    const sandbox = await loadInteraction({ chrome: { tabs, scripting, debugger: debuggerApi } })
    const shot = await sandbox.handleCommand('screenshot', { tabId: 7 })
    const clicked = await sandbox.handleCommand('visualClick', {
      tabId: 7,
      frameId: shot.visualFrameId,
      visualAuthority: true,
      xRatio: 0.30,
      yRatio: 0.78,
      targetHint: '哎哟，不错哦，发条评论吧 评论输入框',
    })

    expect(pressedPoints[0]).toEqual({ x: 300, y: 624 })
    expect(pressedPoints[1]).toEqual({ x: 480, y: 625 })
    expect(clicked).toMatchObject({
      ok: true,
      visualAuthority: true,
      requestedClickX: 300,
      requestedClickY: 624,
      resolvedClickX: 300,
      resolvedClickY: 624,
      visualSnapped: false,
      targetFocusedEditable: true,
      postVisualEditorFocus: true,
      cdpPiercedFollowupEditor: true,
    })
    expect(clicked.stateEvidence).toMatch(/post-click Shadow-DOM focus recovery/)
  })

  it('checks exact visual item text before trusted input without relocating the point', async () => {
    const source = await readFile(interactionPath, 'utf8')
    const verifyIndex = source.indexOf('visualPointMatchesExpectedText(initialTarget, expectedVisualText)')
    const liveProbeIndex = source.indexOf('const probeResults = await chrome.scripting.executeScript')
    const dispatchIndex = source.indexOf('await interactionDispatchTrustedMouseClick(tabId, trustedX, trustedY)', liveProbeIndex)
    expect(verifyIndex).toBeGreaterThan(0)
    expect(liveProbeIndex).toBeGreaterThan(0)
    expect(dispatchIndex).toBeGreaterThan(liveProbeIndex)
    expect(source).toContain('visual screenshot point is not inside the item labeled')
    expect(source).toContain('refusing trusted input without relocating the coordinate')
  })

  it('types Unicode text through trusted CURRENT browser focus for shadow/editor fallbacks', async () => {
    const debuggerCalls: Array<{ method: string; params: any }> = []
    const scripting = {
      async executeScript(request: any) {
        if (request.func?.name === 'interactionMainWorldFocusedEditor') {
          const mode = request.args?.[0]
          if (mode === 'verify') {
            return [{ result: {
              ok: true, focusUsable: true, focusedTag: 'div', focusKind: 'editable',
              observedText: '支持👍', inputVerified: true,
              verificationEvidence: 'focused editor contains inserted text',
            } }]
          }
          return [{ result: {
            ok: true, focusUsable: true, clearedByScript: mode === 'probe',
            focusedTag: 'div', focusKind: 'editable', observedText: '',
          } }]
        }
        throw new Error(`unexpected executeScript function ${request.func?.name || 'anonymous'}`)
      },
    }
    const debuggerApi = {
      async attach() {},
      async sendCommand(_target: any, method: string, params: any) { debuggerCalls.push({ method, params }) },
      async detach() {},
    }
    const sandbox = await loadInteraction({ chrome: {
      tabs: {
        get: async () => ({ id: 7, windowId: 2, status: 'complete', url: 'https://example.test/video/1' }),
        update: async (id: number) => ({ id, windowId: 2, status: 'complete', url: 'https://example.test/video/1' }),
        captureVisibleTab: async () => 'data:image/png;base64,AAAA',
      },
      scripting, debugger: debuggerApi,
    } })
    const typed = await sandbox.handleCommand('typeFocused', { tabId: 7, text: '支持👍', clear: true })
    expect(typed).toMatchObject({
      ok: true,
      textLength: 4,
      focusKind: 'editable',
      inputVerified: true,
      verificationEvidence: 'focused editor contains inserted text',
      transport: 'chrome-debugger-insert-text',
    })
    expect(debuggerCalls).toEqual([{ method: 'Input.insertText', params: { text: '支持👍' } }])
  })

  it('refuses to claim focused text success when neither text nor an input event can be verified', async () => {
    const scripting = {
      async executeScript(request: any) {
        if (request.func?.name !== 'interactionMainWorldFocusedEditor') throw new Error('unexpected script')
        const mode = request.args?.[0]
        if (mode === 'verify') {
          return [{ result: {
            ok: true, focusUsable: true, focusedTag: 'bili-comment-editor',
            focusKind: 'custom-focus-host', observedText: '', inputVerified: false, verificationEvidence: '',
          } }]
        }
        return [{ result: {
          ok: true, focusUsable: true, clearedByScript: false,
          focusedTag: 'bili-comment-editor', focusKind: 'custom-focus-host', observedText: '',
        } }]
      },
    }
    const debuggerApi = {
      async attach() {},
      async sendCommand() {},
      async detach() {},
    }
    const sandbox = await loadInteraction({ chrome: {
      tabs: {
        get: async () => ({ id: 7, windowId: 2, status: 'complete', url: 'https://example.test/video/1' }),
        update: async (id: number) => ({ id, windowId: 2, status: 'complete', url: 'https://example.test/video/1' }),
        captureVisibleTab: async () => 'data:image/png;base64,AAAA',
      },
      scripting, debugger: debuggerApi,
    } })
    await expect(sandbox.handleCommand('typeFocused', { tabId: 7, text: '支持', clear: true }))
      .rejects.toThrow(/refusing to claim text input succeeded/)
  })

  it('downscales only explicit model-visual screenshots while preserving viewport geometry', async () => {
    const viewport = {
      urlIdentity: 'https://example.test/video/1',
      width: 1920, height: 1080, offsetLeft: 0, offsetTop: 0, scale: 1, scrollX: 0, scrollY: 300,
    }
    const debuggerCalls: Array<{ method: string; params?: any }> = []
    let visibleCaptureCalls = 0
    const debuggerApi = {
      async attach() {},
      async sendCommand(_target: any, method: string, params?: any) {
        debuggerCalls.push({ method, params })
        if (method === 'Page.getLayoutMetrics') {
          return { cssVisualViewport: { clientWidth: 1920, clientHeight: 1080, pageX: 0, pageY: 300 } }
        }
        if (method === 'Page.captureScreenshot') return { data: 'COMPACTJPEG' }
        return {}
      },
      async detach() {},
    }
    const scripting = {
      async executeScript(request: any) {
        if (request.func?.name === 'interactionMainWorldViewportState') return [{ result: { ...viewport } }]
        throw new Error(`unexpected executeScript function ${request.func?.name || 'anonymous'}`)
      },
    }
    const tabs = {
      get: async () => ({ id: 7, windowId: 2, status: 'complete', url: 'https://example.test/video/1' }),
      update: async (id: number) => ({ id, windowId: 2, status: 'complete', url: 'https://example.test/video/1' }),
      captureVisibleTab: async () => { visibleCaptureCalls += 1; return 'data:image/jpeg;base64,FULL' },
    }
    const sandbox = await loadInteraction({ chrome: { tabs, scripting, debugger: debuggerApi } })
    const shot = await sandbox.handleCommand('screenshot', { tabId: 7, format: 'jpeg', maxWidth: 1024, quality: 68 })

    expect(shot).toMatchObject({
      ok: true,
      compactVisual: true,
      dataUrl: 'data:image/jpeg;base64,COMPACTJPEG',
      viewportWidth: 1920,
      viewportHeight: 1080,
    })
    expect(shot.captureScale).toBeCloseTo(1024 / 1920)
    expect(visibleCaptureCalls).toBe(0)
    const capture = debuggerCalls.find(call => call.method === 'Page.captureScreenshot')
    expect(capture?.params?.clip).toMatchObject({ width: 1920, height: 1080, y: 300 })
    expect(capture?.params?.quality).toBe(68)
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

  it('gives live visual teaching exact coordinate authority while keeping DOM-assisted replay guarded', async () => {
    const source = await readFile(interactionPath, 'utf8')
    expect(source).toContain("visualAuthority = false")
    expect(source).toContain('const visualAuthority = args.visualAuthority === true')
    expect(source).toMatch(/targetHint,\r?\n\s+visualAuthority,/)
    expect(source).toContain('const resolveHintTarget = (initialTarget, originalX, originalY) =>')
    expect(source).toContain('visualAuthority ? undefined : await interactionResolvePiercedEditablePoint')
    expect(source).toContain('let trustedX = visualAuthority')
    expect(source).toContain('? clientX')
    expect(source).toContain('await interactionDispatchTrustedMouseClick(tabId, trustedX, trustedY)')
    expect(source).toContain("bindingSource: visualAuthority ? 'visual-hit-test-post-click-learning'")
    expect(source).toContain('visual-learned-semantic-replay')
    expect(source).toContain('physicalClickUncertain')
    expect(source).toContain('interactionPiercedEditableIsLocalToVisualPoint')
    expect(source).toContain('postVisualEditorFocus')
  })

  it('falls back from a stale explicit tab id to the CURRENT active browser tab', async () => {
    const source = await readFile(backgroundPath, 'utf8')
    expect(source).toContain('const tab = await chrome.tabs.get(explicit)')
    expect(source).toContain("await chrome.tabs.query({ active: true, currentWindow: true })")
    expect(source).toContain("const activeTabs = await chrome.tabs.query({ active: true })")
    expect(source).toContain('safer than sending every simple DOM command to a permanently dead id')
  })


  it('maps compact screenshot ratios through the exact CDP capture rectangle instead of the generic viewport', async () => {
    const viewport = {
      urlIdentity: 'https://example.test/video/1',
      width: 1600,
      height: 900,
      offsetLeft: 5,
      offsetTop: 7,
      scale: 1,
      scrollX: 10,
      scrollY: 400,
      innerWidth: 1600,
      innerHeight: 900,
      devicePixelRatio: 1.25,
    }
    const mouseEvents: Array<{ method: string; params: any }> = []
    const scripting = {
      async executeScript(request: any) {
        if (request.func?.name === 'interactionMainWorldViewportState') return [{ result: { ...viewport } }]
        if (request.func?.name === 'interactionMainWorldVisualClick') {
          return [{ result: {
            ok: true,
            selector: '#target',
            tag: 'button',
            role: 'button',
            text: 'Target',
            stateSignature: mouseEvents.length ? 'after' : 'before',
            targetFocusedEditable: false,
          } }]
        }
        throw new Error(`unexpected executeScript function ${request.func?.name || 'anonymous'}`)
      },
    }
    const debuggerApi = {
      async attach() {},
      async sendCommand(_target: any, method: string, params: any) {
        if (method === 'Page.getLayoutMetrics') {
          return { cssVisualViewport: { clientWidth: 1600, clientHeight: 900, pageX: 35, pageY: 440 } }
        }
        if (method === 'Page.captureScreenshot') return { data: 'AAAA' }
        if (method === 'Input.dispatchMouseEvent') {
          mouseEvents.push({ method, params })
          return {}
        }
        throw new Error(`unexpected debugger command ${method}`)
      },
      async detach() {},
    }
    const tabs = {
      get: async () => ({ id: 7, windowId: 2, status: 'complete', url: 'https://example.test/video/1' }),
      update: async (id: number) => ({ id, windowId: 2, status: 'complete', url: 'https://example.test/video/1' }),
      captureVisibleTab: async () => { throw new Error('compact CDP capture should be used') },
    }
    const sandbox = await loadInteraction({ chrome: { tabs, scripting, debugger: debuggerApi } })

    const shot = await sandbox.handleCommand('screenshot', {
      tabId: 7,
      format: 'jpeg',
      maxWidth: 1024,
      quality: 68,
    })
    expect(shot).toMatchObject({
      compactVisual: true,
      captureScale: 0.512,
      captureClientLeft: 25,
      captureClientTop: 40,
      captureWidth: 1600,
      captureHeight: 900,
      captureMode: 'cdp-css-visual-viewport',
    })

    await sandbox.handleCommand('visualClick', {
      tabId: 7,
      frameId: shot.visualFrameId,
      visualAuthority: true,
      xRatio: 0.25,
      yRatio: 0.5,
      targetHint: 'Target button',
    })

    const pressed = mouseEvents.find(item => item.params?.type === 'mousePressed')
    expect(pressed?.params).toMatchObject({ x: 425, y: 490, button: 'left' })
    // The JS visualViewport offset was (5, 7). If the click had reused that
    // generic viewport instead of the screenshot's CDP clip it would be (405, 457).
    expect(pressed?.params.x).not.toBe(405)
    expect(pressed?.params.y).not.toBe(457)
  })


  it('replays corrected normalized visual ratios against CURRENT capture geometry after a small viewport resize', async () => {
    const currentViewport = {
      urlIdentity: 'https://example.test/video/1',
      width: 1100,
      height: 880,
      offsetLeft: 0,
      offsetTop: 0,
      scale: 1,
      scrollX: 0,
      scrollY: 400,
      innerWidth: 1100,
      innerHeight: 880,
      devicePixelRatio: 1,
    }
    let visualArgs: any[] | undefined
    const scripting = {
      async executeScript(request: any) {
        if (request.func?.name === 'interactionMainWorldViewportState') return [{ result: { ...currentViewport } }]
        if (String(request.func).includes('window.scrollTo')) return [{ result: undefined }]
        if (request.func?.name === 'interactionMainWorldVisualClick') {
          visualArgs = request.args
          return [{ result: {
            ok: true,
            selector: '',
            tag: 'button',
            role: 'button',
            text: 'Target',
            stateSignature: 'target',
            targetStateChanged: true,
            targetFocusedEditable: false,
            clickX: request.args?.[0],
            clickY: request.args?.[1],
          } }]
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

    const clicked = await sandbox.handleCommand('visualClick', {
      tabId: 7,
      xRatio: 0.60,
      yRatio: 0.80,
      targetHint: 'Target button',
      urlIdentity: 'https://example.test/video/1',
      viewportWidth: 1000,
      viewportHeight: 800,
      scrollX: 0,
      scrollY: 400,
      captureClientLeft: 0,
      captureClientTop: 0,
      captureWidth: 1000,
      captureHeight: 800,
      captureMode: 'cdp-css-visual-viewport',
    })

    expect(visualArgs?.[0]).toBeCloseTo(660)
    expect(visualArgs?.[1]).toBeCloseTo(704)
    expect(clicked).toMatchObject({
      ok: true,
      captureClientLeft: 0,
      captureClientTop: 0,
      captureWidth: 1100,
      captureHeight: 880,
      xRatio: 0.60,
      yRatio: 0.80,
    })
  })

  it('ranks a semantically matching comment-editor activator above an unrelated editable search input', async () => {
    const debuggerApi = {
      async attach() {},
      async sendCommand(_target: any, method: string, params: any) {
        if (method === 'DOM.getDocument') {
          return {
            root: {
              nodeName: '#document',
              backendNodeId: 1,
              children: [
                {
                  nodeName: 'INPUT',
                  backendNodeId: 20,
                  attributes: ['type', 'search', 'placeholder', '搜索'],
                },
                {
                  nodeName: 'BILI-COMMENT-EDITOR',
                  backendNodeId: 30,
                  attributes: ['class', 'comment-editor', 'data-placeholder', '发表评论'],
                },
              ],
            },
          }
        }
        if (method === 'DOM.resolveNode') {
          if (params.backendNodeId === 20) return { object: { objectId: 'search-20' } }
          if (params.backendNodeId === 30) return { object: { objectId: 'comment-30' } }
        }
        if (method === 'Runtime.callFunctionOn') {
          if (params.objectId === 'search-20') {
            return { result: { value: { left: 100, top: 20, right: 400, bottom: 56, width: 300, height: 36 } } }
          }
          if (params.objectId === 'comment-30') {
            return { result: { value: { left: 300, top: 600, right: 800, bottom: 650, width: 500, height: 50 } } }
          }
        }
        throw new Error(`unexpected debugger command ${method}`)
      },
      async detach() {},
    }
    const sandbox = await loadInteraction({ chrome: { tabs: {}, scripting: {}, debugger: debuggerApi } })
    const resolved = await sandbox.interactionResolvePiercedEditablePoint(7, '评论输入框', 520, 620)

    expect(resolved).toMatchObject({
      backendNodeId: 30,
      kind: 'activator',
      x: 550,
      y: 625,
      source: 'cdp-pierced-editor-activator',
    })
  })

  it('deep-hit-tests Shadow DOM before visual clicks and can snap an offset point to the intended editor', async () => {
    const source = await readFile(interactionPath, 'utf8')
    expect(source).toContain('const deepElementFromPoint = (x, y) =>')
    expect(source).toContain('hit.shadowRoot.elementFromPoint?.(x, y)')
    expect(source).toContain('const shadowHostContext = element =>')
    expect(source).toContain('shadowHostContext(element)')
    expect(source).toContain("visual targetHint does not match any CURRENT DOM target; refusing a coordinate-only click")
    expect(source).toContain('right.score - left.score || left.distance - right.distance')
    expect(source).toContain('if (wantsEditable && !isEditableTarget(resolved) && !isLocalizedCommentEditorActivator(resolved)) continue')
    expect(source).toContain('rawPointPreserved: true')
    expect(source).toContain("DOM.getDocument', { depth: -1, pierce: true }")
    expect(source).toContain("'cdp-pierced-shadow-editor'")
    expect(source).toContain('snapDistance: Math.hypot(clickX - originalX, clickY - originalY)')
    expect(source).toContain('interactionCurrentReplayCaptureGeometry')
    expect(source).toContain('right.score - left.score')
    expect(source).not.toContain("captureWidth: Number.isFinite(Number(args.captureWidth)) ? Number(args.captureWidth) : current.width")
    expect(source).not.toContain("/(?:editor|input|textarea)/i.test(String(element?.tagName || ''))")
  })

  it('requires targetHint for live visual frames but preserves old replay compatibility', async () => {
    const source = await readFile(interactionPath, 'utf8')
    expect(source).toContain("live visualClick requires targetHint")
    const frameGuard = source.indexOf("live visualClick requires targetHint")
    const replayGeometry = source.indexOf("visualClick replay requires selectorHint or recorded URL/viewport/scroll geometry")
    expect(frameGuard).toBeGreaterThan(0)
    expect(replayGeometry).toBeGreaterThan(frameGuard)
  })


  it('treats exact card title semantics as stronger than a broad visual shell or adjacent-card coordinate', async () => {
    const source = await readFile(interactionPath, 'utf8')
    expect(source).toContain(".replace(/current|截图|其中|中的|页面|视频|封面|卡片|按钮")
    expect(source).toContain('const localizedAncestorEvidence = element =>')
    expect(source).toContain('actionableCount <= 4')
    expect(source).toContain("h1', 'h2', 'h3', 'h4', '[class*=\"title\" i]'")
    expect(source).toContain('&& !isBroadShellTarget(initialTarget)')
    expect(source).toContain('if (!wantsEditable && isBroadShellTarget(resolved)) continue')
  })

  it('allows a localized Bilibili comment-editor activation host but rejects the whole bili-comments shell', async () => {
    const source = await readFile(interactionPath, 'utf8')
    expect(source).toContain("if (tag === 'bili-comments') return false")
    expect(source).toContain("if (tag !== 'bili-comment-editor'")
    expect(source).toContain("candidate.kind === 'activator' && (width < 60 || height < 18 || height > 220)")
    expect(source).toContain("piercedEditable?.kind === 'activator'")
    expect(source).toContain("activatedEditor?.kind === 'editable'")
    expect(source).toContain('cdpPiercedFollowupEditor')
  })


  it('physically resizes captureVisibleTab fallback frames so read_image cannot inherit a 2880px raster', async () => {
    const viewport = {
      urlIdentity: 'https://example.test/video/1',
      width: 1425, height: 709, offsetLeft: 0, offsetTop: 0, scale: 1,
      scrollX: 0, scrollY: 600, innerWidth: 1425, innerHeight: 709, devicePixelRatio: 2,
    }
    let resizeCalls = 0
    const scripting = {
      async executeScript(request: any) {
        if (request.func?.name === 'interactionMainWorldViewportState') return [{ result: { ...viewport } }]
        if (request.func?.name === 'interactionMainWorldResizeCapturedDataUrl') {
          resizeCalls += 1
          expect(request.args?.[1]).toBe(1536)
          return [{ result: {
            dataUrl: 'data:image/jpeg;base64,RESIZED1536',
            scale: 1536 / 2880,
            width: 1536,
            height: 756,
            originalWidth: 2880,
            originalHeight: 1418,
          } }]
        }
        throw new Error(`unexpected script ${request.func?.name || 'anonymous'}`)
      },
    }
    const tabs = {
      get: async () => ({ id: 7, windowId: 2, status: 'complete', url: 'https://example.test/video/1' }),
      update: async (id: number) => ({ id, windowId: 2, status: 'complete', url: 'https://example.test/video/1' }),
      captureVisibleTab: async () => 'data:image/jpeg;base64,FULL2880',
    }
    const sandbox = await loadInteraction({ chrome: { tabs, scripting } })
    const shot = await sandbox.handleCommand('screenshot', { tabId: 7, format: 'jpeg', maxWidth: 1536, quality: 72 })

    expect(resizeCalls).toBe(1)
    expect(shot).toMatchObject({
      dataUrl: 'data:image/jpeg;base64,RESIZED1536',
      compactVisual: true,
      targetPixelWidth: 1536,
      captureDevicePixelRatio: 2,
    })
    expect(shot.captureScale).toBeCloseTo(1536 / 2880)
  })

  it('treats maxWidth as a final raster-pixel budget on high-DPR browser pages', async () => {
    const viewport = {
      urlIdentity: 'https://example.test/video/1',
      width: 1425, height: 709, offsetLeft: 0, offsetTop: 0, scale: 1,
      scrollX: 0, scrollY: 1956, innerWidth: 1425, innerHeight: 709, devicePixelRatio: 2,
    }
    const debuggerCalls: Array<{ method: string; params?: any }> = []
    const debuggerApi = {
      async attach() {},
      async sendCommand(_target: any, method: string, params?: any) {
        debuggerCalls.push({ method, params })
        if (method === 'Page.getLayoutMetrics') {
          return { cssVisualViewport: { clientWidth: 1425, clientHeight: 709, pageX: 0, pageY: 1956 } }
        }
        if (method === 'Page.captureScreenshot') return { data: 'DPR_AWARE' }
        return {}
      },
      async detach() {},
    }
    const scripting = {
      async executeScript(request: any) {
        if (request.func?.name === 'interactionMainWorldViewportState') return [{ result: { ...viewport } }]
        throw new Error('unexpected script')
      },
    }
    const tabs = {
      get: async () => ({ id: 7, windowId: 2, status: 'complete', url: 'https://example.test/video/1' }),
      update: async (id: number) => ({ id, windowId: 2, status: 'complete', url: 'https://example.test/video/1' }),
      captureVisibleTab: async () => { throw new Error('DPR-aware compact CDP capture should be used') },
    }
    const sandbox = await loadInteraction({ chrome: { tabs, scripting, debugger: debuggerApi } })
    const shot = await sandbox.handleCommand('screenshot', { tabId: 7, format: 'jpeg', maxWidth: 1536, quality: 72 })

    expect(shot).toMatchObject({
      compactVisual: true,
      targetPixelWidth: 1536,
      captureDevicePixelRatio: 2,
      captureWidth: 1425,
      captureHeight: 709,
    })
    expect(shot.captureScale).toBeCloseTo(1536 / (1425 * 2))
    const capture = debuggerCalls.find(call => call.method === 'Page.captureScreenshot')
    expect(capture?.params?.clip?.scale).toBeCloseTo(1536 / 2850)
    expect(capture?.params?.quality).toBe(72)
  })

  it('requires replay fingerprint verification and refuses duplicate fallback after uncertain native dispatch', async () => {
    const source = await readFile(interactionPath, 'utf8')
    expect(source).toContain('interactionValidateVisualReplaySelector')
    expect(source).toContain('visual-selector-replay+fingerprint-verified')
    expect(source).toContain('interactionVerifyPiercedTargetHit')
    expect(source).toContain('includeUserAgentShadowDOM: true')
    expect(source).toContain('physicalClickUncertain')
    expect(source).toContain('refusing synthetic duplicate')
    expect(source).toContain('requestedXRatio')
    expect(source).toContain('effectiveXRatio')
  })

  it('keeps strict publish resolution for replay but never uses it to relocate a live visual teaching point', async () => {
    const source = await readFile(interactionPath, 'utf8')
    expect(source).toContain('function interactionWantsPublishTarget(targetHint)')
    expect(source).toContain('async function interactionResolvePiercedActionPoint')
    expect(source).toContain("'cdp-pierced-publish-action'")
    expect(source).toContain("'Accessibility.getFullAXTree'")
    expect(source).toContain('interactionPublishLabelScore')
    expect(source).toContain('const piercedAction = visualAuthority || piercedEditable ? undefined : await interactionResolvePiercedActionPoint')
    expect(source).toContain('if (!visualAuthority && wantsPublish')
    expect(source).toContain('if (!visualAuthority && interactionWantsPublishTarget(targetHint))')
    expect(source).toContain('live screenshot-bound teaching')
    expect(source).toMatch(/发布\|发表\|发送\|提交/)
  })


  it('does not let missing DOM publish proof block or relocate a live visual physical click', async () => {
    const viewport = {
      urlIdentity: 'https://example.test/video/1',
      width: 1000, height: 800, offsetLeft: 0, offsetTop: 0, scale: 1,
      scrollX: 0, scrollY: 1200, innerWidth: 1000, innerHeight: 800, devicePixelRatio: 1,
    }
    const mouseEvents: Array<{ method: string; params: any }> = []
    const scripting = {
      async executeScript(request: any) {
        if (request.func?.name === 'interactionMainWorldViewportState') return [{ result: { ...viewport } }]
        if (request.func?.name === 'interactionMainWorldVisualClick') {
          const x = Number(request.args?.[0]), y = Number(request.args?.[1])
          expect(request.args?.[8]).toBe(true)
          return [{ result: {
            ok: true,
            selector: 'a.recommended-video',
            replaySelectorSafe: true,
            selectorQuality: 'medium',
            bindingActionable: true,
            bindingSource: 'visual-hit-test-post-click-learning',
            visualAuthority: true,
            tag: 'a',
            role: 'link',
            text: '旁边推荐视频',
            clickX: x,
            clickY: y,
            stateSignature: 'recommended-video',
            targetFocusedEditable: false,
            publishActionVerified: false,
          } }]
        }
        throw new Error(`unexpected script ${request.func?.name || 'anonymous'}`)
      },
    }
    const debuggerApi = {
      async attach() {},
      async sendCommand(_target: any, method: string, params: any) {
        if (method === 'Input.dispatchMouseEvent') {
          mouseEvents.push({ method, params })
          return {}
        }
        throw new Error(`live visual authority must not pre-resolve DOM via ${method}`)
      },
      async detach() {},
    }
    const tabs = {
      get: async () => ({ id: 7, windowId: 2, status: 'complete', url: 'https://example.test/video/1' }),
      update: async (id: number) => ({ id, windowId: 2, status: 'complete', url: 'https://example.test/video/1' }),
      captureVisibleTab: async () => 'data:image/png;base64,AAAA',
    }
    const sandbox = await loadInteraction({ chrome: { tabs, scripting, debugger: debuggerApi } })
    const shot = await sandbox.handleCommand('screenshot', { tabId: 7 })
    const clicked = await sandbox.handleCommand('visualClick', {
      tabId: 7,
      frameId: shot.visualFrameId,
      visualAuthority: true,
      xRatio: 0.90,
      yRatio: 0.60,
      targetHint: '蓝色发布按钮',
    })

    const pressed = mouseEvents.find(item => item.params?.type === 'mousePressed')
    expect(pressed?.params).toMatchObject({ x: 900, y: 480, button: 'left' })
    expect(clicked).toMatchObject({
      ok: true,
      requestedClickX: 900,
      requestedClickY: 480,
      resolvedClickX: 900,
      resolvedClickY: 480,
      xRatio: 0.9,
      yRatio: 0.6,
      visualSnapped: false,
      visualAuthority: true,
      bindingActionable: true,
    })
  })

  it('learns a reusable DOM binding from the element under an exact successful visual point without moving that point', async () => {
    const viewport = {
      urlIdentity: 'https://example.test/video/1',
      width: 1000, height: 800, offsetLeft: 0, offsetTop: 0, scale: 1,
      scrollX: 0, scrollY: 1200, innerWidth: 1000, innerHeight: 800, devicePixelRatio: 1,
    }
    const mouseEvents: Array<{ method: string; params: any }> = []
    const scripting = {
      async executeScript(request: any) {
        if (request.func?.name === 'interactionMainWorldViewportState') return [{ result: { ...viewport } }]
        if (request.func?.name === 'interactionMainWorldVisualClick') {
          const x = Number(request.args?.[0]), y = Number(request.args?.[1])
          return [{ result: {
            ok: true,
            selector: 'button.comment-publish',
            replaySelectorSafe: true,
            selectorQuality: 'strong',
            bindingActionable: true,
            bindingSource: 'visual-hit-test-post-click-learning',
            visualAuthority: true,
            tag: 'button',
            role: 'button',
            text: '发布',
            title: '发布',
            ariaLabel: '发布',
            className: 'comment-publish',
            clickX: x,
            clickY: y,
            stateSignature: mouseEvents.length ? 'published' : 'ready',
            targetFocusedEditable: false,
          } }]
        }
        throw new Error(`unexpected script ${request.func?.name || 'anonymous'}`)
      },
    }
    const debuggerApi = {
      async attach() {},
      async sendCommand(_target: any, method: string, params: any) {
        if (method === 'Input.dispatchMouseEvent') {
          mouseEvents.push({ method, params })
          return {}
        }
        throw new Error(`unexpected debugger command ${method}`)
      },
      async detach() {},
    }
    const tabs = {
      get: async () => ({ id: 7, windowId: 2, status: 'complete', url: 'https://example.test/video/1' }),
      update: async (id: number) => ({ id, windowId: 2, status: 'complete', url: 'https://example.test/video/1' }),
      captureVisibleTab: async () => 'data:image/png;base64,AAAA',
    }
    const sandbox = await loadInteraction({ chrome: { tabs, scripting, debugger: debuggerApi } })
    const shot = await sandbox.handleCommand('screenshot', { tabId: 7 })
    const clicked = await sandbox.handleCommand('visualClick', {
      tabId: 7,
      frameId: shot.visualFrameId,
      visualAuthority: true,
      xRatio: 0.725,
      yRatio: 0.76375,
      targetHint: '蓝色发布按钮',
    })

    const pressed = mouseEvents.find(item => item.params?.type === 'mousePressed')
    expect(pressed?.params).toMatchObject({ x: 725, y: 611, button: 'left' })
    expect(clicked).toMatchObject({
      ok: true,
      selectorHint: 'top-frame::button.comment-publish',
      selectorReplaySafe: true,
      selectorQuality: 'strong',
      bindingActionable: true,
      bindingSource: 'visual-hit-test-post-click-learning',
      visualAuthority: true,
      targetTag: 'button',
      targetRole: 'button',
      targetText: '发布',
      xRatio: 0.725,
      yRatio: 0.76375,
      requestedXRatio: 0.725,
      requestedYRatio: 0.76375,
      visualSnapped: false,
    })
  })

})
