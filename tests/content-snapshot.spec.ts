import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(process.cwd(), 'browser-extension', 'content.js'), 'utf8')

class FakeElement {
  nodeType = 1
  id = ''
  className = ''
  parentElement: FakeElement | null = null
  children: FakeElement[] = []
  textContent = ''
  innerText = ''
  style = { display: 'block', visibility: 'visible', opacity: '1', cursor: 'default' }
  attributes = new Map<string, string>()

  constructor(public tagName: string, public bounds = rect(0, 0, 100, 24)) {}

  getBoundingClientRect() { return this.bounds }
  getAttribute(name: string) { return this.attributes.get(name) ?? null }
  querySelectorAll() { return this.children }
  matches(selector: string) {
    if (selector.includes('[onclick]') && this.attributes.has('onclick')) return true
    return selector.split(',').map(item => item.trim()).includes(this.tagName.toLowerCase())
  }
}

function rect(left: number, top: number, width: number, height: number) {
  return { left, top, width, height, right: left + width, bottom: top + height }
}

function setup(elements: FakeElement[]) {
  const body = new FakeElement('BODY', rect(0, 0, 1280, 720))
  body.children = elements
  for (const element of elements) element.parentElement = body
  const document = {
    body,
    documentElement: body,
    querySelector() { return body },
    querySelectorAll(selector: string) {
      if (selector.includes('div') || selector.includes('span')) return elements
      return []
    },
  }
  const context = vm.createContext({
    chrome: { runtime: { onMessage: { addListener() {} } } },
    document,
    location: { href: 'https://example.test' },
    window: { innerWidth: 1280, innerHeight: 720 },
    HTMLInputElement: class {},
    HTMLAnchorElement: class {},
    getComputedStyle: (element: FakeElement) => element.style,
    CSS: { escape: (value: string) => value },
    Node: { ELEMENT_NODE: 1 },
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
  return context
}

describe('browser content snapshot', () => {
  it('surfaces Ant table action text carried by a title even when the span itself has no pointer cursor', () => {
    const rdp = new FakeElement('SPAN', rect(990, 420, 180, 32))
    rdp.className = 'act_margin_left'
    rdp.attributes.set('title', '[RDP] [EMPTY]')

    const context = setup([rdp])
    const value = JSON.parse(JSON.stringify(vm.runInContext('snapshot({ maxElements: 20 })', context)))

    expect(value.elements).toContainEqual(expect.objectContaining({
      tag: 'span',
      text: '[RDP] [EMPTY]',
    }))
  })
})
