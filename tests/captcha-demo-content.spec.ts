import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(process.cwd(), 'browser-extension', 'captcha-demo-content.js'), 'utf8')

type Rect = { left: number; top: number; width: number; height: number; right: number; bottom: number }

type FakeElement = {
  id: string
  style: { display: string; visibility: string; opacity: string }
  rect: Rect
  attributes: Map<string, string>
  tagName: string
  nodeType: number
  parentElement: FakeElement | null
  children: FakeElement[]
  textContent: string
  innerText: string
  querySelector: (selector: string) => FakeElement | null
  getAttribute: (name: string) => string | null
  hasAttribute: (name: string) => boolean
  getBoundingClientRect: () => Rect
  scrollIntoView: () => void
  dispatchEvent: (event: unknown) => boolean
}

function rect(left: number, top: number, width: number, height: number): Rect {
  return { left, top, width, height, right: left + width, bottom: top + height }
}

function element(id: string, bounds: Rect, attributes: Record<string, string> = {}): FakeElement {
  const values = new Map(Object.entries(attributes))
  return {
    id,
    style: { display: 'block', visibility: 'visible', opacity: '1' },
    rect: bounds,
    attributes: values,
    tagName: 'DIV',
    nodeType: 1,
    parentElement: null,
    children: [],
    textContent: '',
    innerText: '',
    querySelector: () => null,
    getAttribute: name => values.get(name) ?? null,
    hasAttribute: name => values.has(name),
    getBoundingClientRect() { return this.rect },
    scrollIntoView() {},
    dispatchEvent() { return true },
  }
}

function appendChild(parent: FakeElement, child: FakeElement) {
  child.parentElement = parent
  parent.children.push(child)
  return child
}

function loadContext(options: {
  querySelector?: (selector: string) => FakeElement | null
  querySelectorAll?: (selector: string) => FakeElement[]
} = {}) {
  const document = {
    body: {},
    querySelector: options.querySelector ?? (() => null),
    querySelectorAll: options.querySelectorAll ?? (() => []),
    dispatchEvent: () => true,
  }
  const context = vm.createContext({
    chrome: { runtime: { onMessage: { addListener: () => {} } } },
    crypto: { randomUUID: () => 'doc-test' },
    location: { origin: 'https://demo.test' },
    window: { innerWidth: 1000, innerHeight: 800 },
    document,
    getComputedStyle: (value: FakeElement) => value.style,
    CSS: { escape: (value: string) => value.replace(/[^A-Za-z0-9_-]/g, '\\$&') },
    Node: { ELEMENT_NODE: 1 },
    Event: class Event { constructor(public type: string, public init?: unknown) {} },
    PointerEvent: class PointerEvent { constructor(public type: string, public init?: unknown) {} },
    MouseEvent: class MouseEvent { constructor(public type: string, public init?: unknown) {} },
    setTimeout: (callback: () => void) => { callback(); return 0 },
    clearTimeout: () => {},
    console,
    Math,
    Date,
    Promise,
    Set,
    Map,
    WeakMap,
    Number,
    String,
    Array,
    Object,
    RegExp,
    Error,
  })
  vm.runInContext(source, context)
  return context
}

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

describe('captcha demo content bridge', () => {
  it('ignores a stale hidden captcha root and selects the visible one', async () => {
    const hiddenRoot = element('hidden-root', rect(20, 20, 0, 0), {
      'data-dsh-patrol-captcha-kind': 'click-sequence',
      'data-target-text': '旧',
    })
    const visibleRoot = element('visible-root', rect(100, 100, 360, 240), {
      'data-dsh-patrol-captcha-kind': 'click-sequence',
      'data-target-text': '春山水',
    })
    const image = element('captcha-image', rect(110, 120, 320, 180), {
      'data-dsh-patrol-captcha-image': '',
    })
    image.tagName = 'IMG'
    visibleRoot.querySelector = selector => selector.includes('captcha-image') ? image : null
    hiddenRoot.querySelector = () => null

    const context = loadContext({
      querySelectorAll: selector => selector.includes('click-sequence') ? [hiddenRoot, visibleRoot] : [],
      querySelector: selector => selector === '#captcha-image' ? image : null,
    })

    const info = plain(vm.runInContext('captchaDemoInfo()', context)) as {
      available: boolean
      kinds: string[]
      documentKey: string
      challengeKeys: Record<string, string>
    }
    expect(info).toMatchObject({ available: true, kinds: ['click-sequence'], documentKey: 'doc-test' })
    expect(info.challengeKeys['click-sequence']).toBe('doc-test:1')

    const target = plain(await vm.runInContext(
      `captchaDemoTarget({kind:'click-sequence', documentKey:'doc-test', challengeKey:'${info.challengeKeys['click-sequence']}'})`,
      context,
    ))
    expect(target).toMatchObject({
      available: true,
      kind: 'click-sequence',
      targetText: '春山水',
      imageSelector: '#captcha-image',
      documentKey: 'doc-test',
      challengeKey: 'doc-test:1',
    })
  })

  it('rejects a stale action after the page instance changes', async () => {
    const context = loadContext()
    await expect(vm.runInContext(
      "captchaDemoTarget({kind:'click-sequence', documentKey:'old-document', challengeKey:'old-challenge'})",
      context,
    )).rejects.toThrow(/page changed/)
  })

  it('rejects coordinates when an SPA replaces the captcha root in the same document', async () => {
    const firstRoot = element('first-root', rect(100, 100, 320, 220), {
      'data-dsh-patrol-captcha-kind': 'click-sequence',
      'data-target-text': '春',
    })
    const secondRoot = element('second-root', rect(100, 100, 320, 220), {
      'data-dsh-patrol-captcha-kind': 'click-sequence',
      'data-target-text': '夏',
    })
    let roots = [firstRoot]
    const context = loadContext({
      querySelectorAll: selector => selector.includes('click-sequence') ? roots : [],
    })
    const info = plain(vm.runInContext('captchaDemoInfo()', context)) as { challengeKeys: Record<string, string> }
    const oldKey = info.challengeKeys['click-sequence']
    roots = [secondRoot]

    await expect(vm.runInContext(
      `captchaDemoTarget({kind:'click-sequence', documentKey:'doc-test', challengeKey:'${oldKey}'})`,
      context,
    )).rejects.toThrow(/challenge changed/)
  })

  it('drags by the matched relative puzzle distance instead of subtracting the handle start offset', async () => {
    const root = element('slider-root', rect(80, 80, 360, 220), {
      'data-dsh-patrol-captcha-kind': 'slider-puzzle',
    })
    const handle = element('handle', rect(100, 100, 40, 40))
    const background = element('background', rect(100, 100, 300, 160))
    const context = loadContext({
      querySelectorAll: selector => selector === '[data-dsh-patrol-captcha-kind="slider-puzzle"]' ? [root] : [],
      querySelector: selector => {
        if (selector === '#handle') return handle
        if (selector === '#background') return background
        return null
      },
    })
    const info = plain(vm.runInContext('captchaDemoInfo()', context)) as { challengeKeys: Record<string, string> }
    const challengeKey = info.challengeKeys['slider-puzzle']

    const result = plain(await vm.runInContext(
      `captchaDemoDrag({kind:'slider-puzzle', documentKey:'doc-test', challengeKey:'${challengeKey}', handleSelector:'#handle', backgroundSelector:'#background', normalizedX:0.5})`,
      context,
    ))
    expect(result).toMatchObject({ ok: true, normalizedX: 0.5, distance: 150 })
  })

  it('auto-detects an unmarked click-sequence captcha from nearby cues and image geometry', async () => {
    const root = element('weak-click-root', rect(80, 80, 420, 260), {
      class: 'captcha-panel',
    })
    root.innerText = '请在下图依次点击：春山水'
    root.textContent = root.innerText
    const image = appendChild(root, element('weak-click-image', rect(110, 140, 320, 180)))
    image.tagName = 'IMG'

    const context = loadContext({
      querySelectorAll: selector => {
        if (selector === '[data-dsh-patrol-captcha-kind="click-sequence"]') return []
        if (selector === '[data-dsh-patrol-captcha-kind="slider-puzzle"]') return []
        if (selector === '[data-dsh-patrol-captcha-kind="slider"]') return []
        if (selector === 'img,canvas') return [image]
        return []
      },
      querySelector: selector => selector === '#weak-click-image' ? image : null,
    })

    const info = plain(vm.runInContext('captchaDemoInfo()', context)) as {
      available: boolean
      kinds: string[]
      challengeKeys: Record<string, string>
    }
    expect(info.available).toBe(true)
    expect(info.kinds).toContain('click-sequence')

    const target = plain(await vm.runInContext(
      `captchaDemoTarget({kind:'click-sequence', documentKey:'doc-test', challengeKey:'${info.challengeKeys['click-sequence']}'})`,
      context,
    ))
    expect(target).toMatchObject({
      available: true,
      kind: 'click-sequence',
      targetText: '春山水',
      imageSelector: '#weak-click-image',
    })
  })

  it('auto-detects an unmarked slider puzzle from nearby assets and handle hints', async () => {
    const root = element('weak-slider-root', rect(60, 60, 460, 280), {
      class: 'geetest_panel',
    })
    root.innerText = '请拖动滑块完成拼图'
    root.textContent = root.innerText
    const background = appendChild(root, element('weak-background', rect(110, 120, 320, 160), {
      class: 'captcha-bg',
    }))
    background.tagName = 'IMG'
    const piece = appendChild(root, element('weak-piece', rect(190, 160, 52, 52), {
      class: 'captcha-piece',
    }))
    piece.tagName = 'IMG'
    const handle = appendChild(root, element('weak-handle', rect(96, 300, 44, 44), {
      class: 'geetest_slider_button',
    }))

    const context = loadContext({
      querySelectorAll: selector => {
        if (selector === '[data-dsh-patrol-captcha-kind="click-sequence"]') return []
        if (selector === '[data-dsh-patrol-captcha-kind="slider-puzzle"]') return []
        if (selector === '[data-dsh-patrol-captcha-kind="slider"]') return []
        if (selector === 'img,canvas') return [background, piece]
        if (selector === '[role="slider"],[class*="slider"],[id*="slider"],[class*="drag"],[id*="drag"],[class*="handle"],[id*="handle"],button') return [handle]
        return []
      },
      querySelector: selector => {
        if (selector === '#weak-background') return background
        if (selector === '#weak-piece') return piece
        if (selector === '#weak-handle') return handle
        return null
      },
    })

    const info = plain(vm.runInContext('captchaDemoInfo()', context)) as {
      available: boolean
      kinds: string[]
      challengeKeys: Record<string, string>
    }
    expect(info.available).toBe(true)
    expect(info.kinds).toContain('slider-puzzle')

    const target = plain(await vm.runInContext(
      `captchaDemoTarget({kind:'slider-puzzle', documentKey:'doc-test', challengeKey:'${info.challengeKeys['slider-puzzle']}'})`,
      context,
    ))
    expect(target).toMatchObject({
      available: true,
      kind: 'slider-puzzle',
      backgroundSelector: '#weak-background',
      pieceSelector: '#weak-piece',
      handleSelector: '#weak-handle',
    })
  })
})
