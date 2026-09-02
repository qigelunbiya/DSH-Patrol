import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(process.cwd(), 'browser-extension', 'captcha-demo-content.js'), 'utf8')

function context() {
  const sandbox = vm.createContext({
    chrome: { runtime: { onMessage: { addListener() {} } } },
    crypto: { randomUUID: () => 'doc-test' },
    location: { origin: 'https://example.test' },
    window: { innerWidth: 1280, innerHeight: 720 },
    document: { body: {}, querySelector() { return null }, querySelectorAll() { return [] } },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', backgroundImage: 'none' }),
    CSS: { escape: (value: string) => value },
    Node: { ELEMENT_NODE: 1 },
    Event: class Event {},
    PointerEvent: class PointerEvent {},
    MouseEvent: class MouseEvent {},
    setTimeout,
    clearTimeout,
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
  vm.runInContext(source, sandbox)
  return sandbox
}

describe('real click-sequence prompt parsing', () => {
  it('uses the DOM instruction instead of guessing requested characters from the image', () => {
    const sandbox = context()
    const result = vm.runInContext("parseClickSequenceTarget('请在下图依次点击：象眼鸽蛋')", sandbox)
    expect(result).toBe('象眼鸽蛋')
  })

  it('stops before the confirmation control text when the root flattens UI text onto one line', () => {
    const sandbox = context()
    const result = vm.runInContext("parseClickSequenceTarget('请在下图依次点击：象 眼 鸽 蛋 确认')", sandbox)
    expect(result).toBe('象眼鸽蛋')
  })
})
