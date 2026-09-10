// @ts-nocheck
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'
import { describe, expect, it } from 'vitest'
import { resolveBrowserExecutable } from '../browser-bridge-runtime/managed-browser.js'

const EXTENSION_PATH = fileURLToPath(new URL('../browser-extension/', import.meta.url))
const PUBLIC_TEST_ROOT = 'http://the-internet.herokuapp.com'
const runPublicSmoke = process.env.GITHUB_ACTIONS === 'true' && process.platform === 'linux'

async function extensionHarness() {
  const browser = await puppeteer.launch({
    browser: 'chrome',
    executablePath: resolveBrowserExecutable(),
    headless: true,
    enableExtensions: [EXTENSION_PATH],
    pipe: true,
    args: ['--no-first-run', '--no-default-browser-check'],
  })
  const target = await browser.waitForTarget(
    candidate => candidate.type() === 'service_worker' && candidate.url().startsWith('chrome-extension://'),
    { timeout: 15000 },
  )
  const worker = await target.worker()
  if (!worker) throw new Error('Patrol extension service worker is unavailable')
  const page = await browser.newPage()

  async function tabId() {
    const url = page.url()
    return await worker.evaluate(async currentUrl => {
      const tabs = await chrome.tabs.query({})
      const exact = tabs.find(tab => tab.url === currentUrl)
      if (!exact?.id) throw new Error(`no extension tab for ${currentUrl}`)
      return exact.id
    }, url)
  }

  async function command(cmd, args = {}) {
    const id = await tabId()
    return await worker.evaluate(async payload => {
      const fn = globalThis.handleCommand
      if (typeof fn !== 'function') throw new Error('extension handleCommand is unavailable')
      return await fn(payload.cmd, { ...payload.args, tabId: payload.tabId })
    }, { cmd, args, tabId: id })
  }

  return { browser, page, command }
}

describe('public real-browser Patrol interaction smoke', () => {
  it.runIf(runPublicSmoke)('uses atomic semantic click and replay-compatible selectors in the actual extension', async () => {
    const harness = await extensionHarness()
    try {
      await harness.page.goto(`${PUBLIC_TEST_ROOT}/add_remove_elements/`, { waitUntil: 'domcontentloaded', timeout: 20000 })

      // The business target is resolved and clicked inside one extension command,
      // exactly like patrol_click_target now does. No snapshot selector is fed
      // back into the semantic click path.
      const semantic = await harness.command('semanticClick', {
        locatorText: 'Add Element',
        locatorRole: 'button',
        task: 'Click Add Element',
      })
      expect(semantic).toMatchObject({ ok: true, text: 'Add Element', role: 'button', transport: 'atomic-main-world-semantic-click' })
      expect(semantic.selector).toMatch(/^top-frame::/)

      const afterSemanticClick = await harness.command('snapshot', { maxElements: 100 })
      const deleteTarget = afterSemanticClick.elements.find(element => element.text === 'Delete')
      expect(deleteTarget?.selector).toMatch(/^top-frame::/)

      // The selector returned/stored by the semantic path must still be usable
      // by the ordinary replay click machinery.
      const replayClick = await harness.command('click', { selector: deleteTarget.selector })
      expect(replayClick.ok).toBe(true)
      const afterReplayClick = await harness.command('snapshot', { maxElements: 100 })
      expect(afterReplayClick.elements.some(element => element.text === 'Delete')).toBe(false)

      await harness.page.goto(`${PUBLIC_TEST_ROOT}/dropdown`, { waitUntil: 'domcontentloaded', timeout: 20000 })
      const dropdownSnapshot = await harness.command('snapshot', { maxElements: 100 })
      const dropdown = dropdownSnapshot.elements.find(element => element.tag === 'select')
      expect(dropdown?.selector).toBe('top-frame::#dropdown')

      const selected = await harness.command('select', { selector: dropdown.selector, label: 'Option 2' })
      expect(selected).toMatchObject({ ok: true, value: '2', label: 'Option 2', index: 2 })
      expect(await harness.page.$eval('#dropdown', element => element.value)).toBe('2')
    } finally {
      await harness.browser.close()
    }
  }, 60000)
})
