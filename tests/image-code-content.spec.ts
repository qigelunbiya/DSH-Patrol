import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(process.cwd(), 'browser-extension', 'content.js'), 'utf8')

class FakeInput {
  tagName = 'INPUT'
  nodeType = 1
  type = 'text'
  name = ''
  id = ''
  className = ''
  maxLength = -1
  value = ''
  parentElement = null
  style = { display: 'block', visibility: 'visible', opacity: '1' }
  constructor(public bounds: any, public form: any = null) {}
  getBoundingClientRect() { return this.bounds }
  getAttribute(name: string) {
    if (name === 'name') return this.name || null
    if (name === 'placeholder') return null
    if (name === 'aria-label') return null
    if (name === 'alt') return null
    if (name === 'title') return null
    if (name === 'src') return null
    return null
  }
  closest(selector: string) { return selector === 'form' ? this.form : null }
  scrollIntoView() {}
  focus() {}
  dispatchEvent() { return true }
}

class FakeImage {
  tagName = 'IMG'
  nodeType = 1
  id = ''
  className = ''
  parentElement = null
  style = { display: 'block', visibility: 'visible', opacity: '1' }
  constructor(public bounds: any, public form: any = null, public src = '') {}
  getBoundingClientRect() { return this.bounds }
  getAttribute(name: string) {
    if (name === 'src') return this.src || null
    return null
  }
  closest(selector: string) { return selector === 'form' ? this.form : null }
  scrollIntoView() {}
}

function rect(left: number, top: number, width: number, height: number) {
  return { left, top, width, height, right: left + width, bottom: top + height }
}

describe('ordinary image-code target discovery', () => {
  it('uses a captcha input to find a nearby generic image instead of the page logo', async () => {
    const form = {}
    const captcha = new FakeInput(rect(900, 400, 120, 40), form)
    captcha.id = 'captcha'
    captcha.name = 'captcha'
    captcha.maxLength = 6

    const logo = new FakeImage(rect(1020, 80, 260, 110), null, '/assets/logo.png')
    logo.id = 'logo'
    const codeImage = new FakeImage(rect(1030, 400, 155, 40), form, '/random/image?id=123')
    codeImage.id = 'legacy-random-image'

    const document = {
      body: {},
      querySelector: (selector: string) => {
        if (selector === '#captcha') return captcha
        if (selector === '#legacy-random-image') return codeImage
        if (selector === '#logo') return logo
        return null
      },
      querySelectorAll: (selector: string) => {
        if (selector === 'input,textarea') return [captcha]
        if (selector === 'img,canvas,svg') return [logo, codeImage]
        return []
      },
    }
    const context = vm.createContext({
      chrome: { runtime: { onMessage: { addListener() {} } } },
      document,
      window: { innerWidth: 1600, innerHeight: 900 },
      location: { href: 'https://10.192.1.125/login', origin: 'https://10.192.1.125' },
      HTMLInputElement: FakeInput,
      HTMLTextAreaElement: class {},
      HTMLAnchorElement: class {},
      getComputedStyle: (element: any) => element.style,
      CSS: { escape: (value: string) => value },
      Node: { ELEMENT_NODE: 1 },
      Event: class {},
      KeyboardEvent: class {},
      URL,
      setTimeout: (callback: () => void) => { callback(); return 0 },
      clearTimeout() {},
      Promise,
      Math,
      Number,
      String,
      Array,
      Object,
      RegExp,
      Error,
    })
    vm.runInContext(source, context)

    const result = JSON.parse(JSON.stringify(await vm.runInContext('imageCodeTarget({})', context)))
    expect(result).toMatchObject({
      ok: true,
      inputSelector: '#captcha',
      imageSelector: '#legacy-random-image',
    })
  })
})
