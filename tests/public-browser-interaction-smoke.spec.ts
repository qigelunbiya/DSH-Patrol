// @ts-nocheck
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'
import { describe, expect, it } from 'vitest'
import { resolveBrowserExecutable } from '../browser-bridge-runtime/managed-browser.js'

const EXTENSION_PATH = fileURLToPath(new URL('../browser-extension/', import.meta.url))
const runPublicSmoke = (process.env.GITHUB_ACTIONS === 'true' && process.platform === 'linux')
  || process.env.DSH_PATROL_PUBLIC_SMOKE === 'true'

async function localTestSite() {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8')
    if (request.url === '/add_remove_elements/') {
      response.end(`<!doctype html><button id="add" onclick="this.insertAdjacentHTML('afterend','<button class=added onclick=this.remove()>Delete</button>')">Add Element</button>`)
      return
    }
    if (request.url === '/dropdown') {
      response.end('<!doctype html><select id="dropdown"><option value="">Please select</option><option value="1">Option 1</option><option value="2">Option 2</option></select>')
      return
    }
    response.statusCode = 404
    response.end('not found')
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('local browser smoke server has no TCP address')
  return {
    root: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  }
}

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

  const manifest = await worker.evaluate(() => chrome.runtime.getManifest())
  return { browser, page, command, manifest }
}

describe('public real-browser Patrol interaction smoke', () => {
  it.runIf(runPublicSmoke)('uses atomic semantic click and replay-compatible selectors in the actual extension', async () => {
    const site = await localTestSite()
    const harness = await extensionHarness()
    try {
      expect(harness.manifest.version).toBe('0.3.1')
      await harness.page.goto(`${site.root}/add_remove_elements/`, { waitUntil: 'domcontentloaded', timeout: 20000 })

      // The business target is resolved and clicked inside one extension command,
      // exactly like patrol_click_target now does. No snapshot selector is fed
      // back into the semantic click path.
      const semantic = await harness.command('semanticClick', {
        locatorText: 'Add Element',
        locatorRole: 'button',
        task: 'Click Add Element',
      })
      expect(semantic).toMatchObject({ ok: true, role: 'button', transport: 'atomic-main-world-semantic-click' })
      expect(semantic.text).toContain('Add Element')
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

      await harness.page.goto(`${site.root}/dropdown`, { waitUntil: 'domcontentloaded', timeout: 20000 })
      const dropdownSnapshot = await harness.command('snapshot', { maxElements: 100 })
      const dropdown = dropdownSnapshot.elements.find(element => element.tag === 'select')
      expect(dropdown?.selector).toBe('top-frame::#dropdown')

      const selected = await harness.command('select', { selector: dropdown.selector, label: 'Option 2' })
      expect(selected).toMatchObject({ ok: true, value: '2', label: 'Option 2', index: 2 })
      expect(await harness.page.$eval('#dropdown', element => element.value)).toBe('2')
    } finally {
      await harness.browser.close()
      await site.close()
    }
  }, 60000)
})
