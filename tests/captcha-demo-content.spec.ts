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
  parentElement: null
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

    const info = plain(vm.runInContext('captchaDemoInfo()', context))
    expect(info).toMatchObject({ available: true, kinds: ['click-sequence'], documentKey: 'doc-test' })

    const target = plain(await vm.runInContext(
      "captchaDemoTarget({kind:'click-sequence', documentKey:'doc-test'})",
      context,
    ))
    expect(target).toMatchObject({
      available: true,
      kind: 'click-sequence',
      targetText: '春山水',
      imageSelector: '#captcha-image',
      documentKey: 'doc-test',
    })
  })

  it('rejects a stale action after the page instance changes', async () => {
    const context = loadContext()
    await expect(vm.runInContext(
      "captchaDemoTarget({kind:'click-sequence', documentKey:'old-document'})",
      context,
    )).rejects.toThrow(/page changed/)
  })

  it('drags by the matched relative puzzle distance instead of subtracting the handle start offset', async () => {
    const handle = element('handle', rect(100, 100, 40, 40))
    const background = element('background', rect(100, 100, 300, 160))
    const context = loadContext({
      querySelector: selector => {
        if (selector === '#handle') return handle
        if (selector === '#background') return background
        return null
      },
    })

    const result = plain(await vm.runInContext(
      "captchaDemoDrag({documentKey:'doc-test', handleSelector:'#handle', backgroundSelector:'#background', normalizedX:0.5})",
      context,
    ))
    expect(result).toMatchObject({ ok: true, normalizedX: 0.5, distance: 150 })
  })
})
