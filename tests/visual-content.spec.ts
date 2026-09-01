import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(process.cwd(), 'browser-extension', 'visual-content.js'), 'utf8')

class FakeElement {
  nodeType = 1
  id = ''
  className = ''
  parentElement: FakeElement | null = null
  children: FakeElement[] = []
  textContent = ''
  currentSrc = ''
  src = ''
  style: any = { display: 'block', visibility: 'visible', opacity: '1', backgroundImage: 'none' }
  attributes = new Map<string, string>()
  constructor(public tagName: string, public bounds: any, public form: any = null) {}
  getBoundingClientRect() { return this.bounds }
  getAttribute(name: string) {
    if (name === 'src') return this.src || this.currentSrc || this.attributes.get(name) || null
    return this.attributes.get(name) || null
  }
  closest(selector: string) { return selector === 'form' ? this.form : null }
  scrollIntoView() {}
  contains(other: any) {
    let node = other
    while (node) {
      if (node === this) return true
      node = node.parentElement
    }
    return false
  }
}

class FakeInput extends FakeElement {
  type = 'text'
  name = ''
  maxLength = -1
  value = ''
  constructor(bounds: any, form: any = null) { super('INPUT', bounds, form) }
}

class FakeImage extends FakeElement {
  constructor(bounds: any, form: any = null, src = '') {
    super('IMG', bounds, form)
    this.src = src
    this.currentSrc = src
  }
}

function rect(left: number, top: number, width: number, height: number) {
  return { left, top, width, height, right: left + width, bottom: top + height }
}

function attach(parent: FakeElement, child: FakeElement) {
  child.parentElement = parent
  parent.children.push(child)
}

function setup(withImage = true) {
  const form = {}
  const body = new FakeElement('BODY', rect(0, 0, 1600, 900), null)
  const row = new FakeElement('DIV', rect(880, 390, 330, 50), form)
  row.className = 'b_captcha'
  attach(body, row)

  const captcha = new FakeInput(rect(885, 395, 115, 40), form)
  captcha.id = 'captcha'
  captcha.name = 'captcha'
  captcha.attributes.set('name', 'captcha')
  captcha.attributes.set('placeholder', '验证码')
  attach(row, captcha)

  const logo = new FakeImage(rect(950, 180, 300, 90), null, '/static/logo.png')
  logo.id = 'brand-logo'
  attach(body, logo)

  const code = new FakeImage(rect(1005, 395, 145, 40), form, 'data:image/png;base64,QUJDRA==')
  if (withImage) attach(row, code)

  const all = withImage ? [row, captcha, logo, code] : [row, captcha, logo]
  const media = withImage ? [logo, code] : [logo]
  const document = {
    body,
    documentElement: body,
    querySelector(selector: string) {
      if (selector === '#captcha') return captcha
      if (selector === '#brand-logo') return logo
      return null
    },
    querySelectorAll(selector: string) {
      if (selector === 'input,textarea') return [captcha]
      if (selector === 'img,canvas,svg') return media
      if (selector === '*') return all
      return []
    },
  }

  const context = vm.createContext({
    chrome: { runtime: { onMessage: { addListener() {} } } },
    document,
    window: { innerWidth: 1600, innerHeight: 900 },
    HTMLInputElement: FakeInput,
    HTMLTextAreaElement: class {},
    getComputedStyle: (element: any) => element.style,
    CSS: { escape: (value: string) => value },
    Node: { ELEMENT_NODE: 1 },
    setTimeout: (callback: () => void) => { callback(); return 0 },
    Promise,
    Math,
    Number,
    String,
    Array,
    Object,
    RegExp,
    Error,
    Set,
    Map,
  })
  vm.runInContext(source, context)
  return { context }
}

describe('visual page capture', () => {
  it('surfaces visible non-interactive images in the Patrol snapshot layer', () => {
    const { context } = setup(true)
    const value = JSON.parse(JSON.stringify(vm.runInContext('snapshotVisuals({ maxElements: 50 })', context)))
    expect(value.ok).toBe(true)
    expect(value.elements.some((item: any) => item.tag === 'img' && /image\/png;base64/.test(item.text))).toBe(true)
  })

  it('selects the generic adjacent captcha image and returns its original data URL', async () => {
    const { context } = setup(true)
    const value = JSON.parse(JSON.stringify(await vm.runInContext('visualImageCodeTarget({})', context)))
    expect(value).toMatchObject({
      ok: true,
      captureMode: 'direct-source',
      inputSelector: '#captcha',
      sourceDataUrl: 'data:image/png;base64,QUJDRA==',
    })
    expect(value.imageSelector).not.toBe('#brand-logo')
  })

  it('falls back to a screenshot region beside the captcha input when no media node is discoverable', async () => {
    const { context } = setup(false)
    const value = JSON.parse(JSON.stringify(await vm.runInContext('visualImageCodeTarget({})', context)))
    expect(value.captureMode).toBe('neighbor-region')
    expect(value.inputSelector).toBe('#captcha')
    expect(value.rect.width).toBeGreaterThan(30)
    expect(value.rect.left).toBeGreaterThanOrEqual(1000)
  })
})
