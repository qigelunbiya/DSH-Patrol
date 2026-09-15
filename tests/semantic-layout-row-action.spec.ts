import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveBrowserExecutable } from '../browser-bridge-runtime/managed-browser.js'

const root = process.cwd()
const extensionPath = join(root, 'browser-extension', 'semantic-layout-row-action.js')
const entryPath = join(root, 'browser-extension', 'background-entry.js')
const extensionSource = readFileSync(extensionPath, 'utf8')
const entrySource = readFileSync(entryPath, 'utf8')
const marker = 'async function semanticLayoutRowActionPageCommand(mode, spec) {'
const markerIndex = extensionSource.indexOf(marker)
if (markerIndex < 0) throw new Error('semantic layout page command marker is missing')
const pageCommandSource = extensionSource.slice(markerIndex).trim()

let browser: Browser | undefined

beforeAll(async () => {
  let executablePath: string
  try {
    executablePath = resolveBrowserExecutable()
  } catch (error) {
    if (process.env.CI) throw error
    return
  }
  browser = await puppeteer.launch({
    browser: 'chrome',
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
}, 30_000)

afterAll(async () => {
  await browser?.close()
})

async function runCommand(page: Page, mode: 'probe' | 'click', spec: Record<string, unknown>): Promise<any> {
  return await page.evaluate(async ({ source, mode, spec }) => {
    const command = (0, eval)(`(${source})`)
    return await command(mode, spec)
  }, { source: pageCommandSource, mode, spec })
}

async function withPage(html: string, run: (page: Page) => Promise<void>): Promise<void> {
  if (!browser) return
  const page = await browser.newPage()
  try {
    await page.setContent(html, { waitUntil: 'domcontentloaded' })
    await run(page)
  } finally {
    await page.close()
  }
}

describe('layout-correlated semantic row actions', () => {
  it('is loaded by the extension service worker entrypoint', () => {
    expect(entrySource).toContain("importScripts('semantic-layout-row-action.js')")
    expect(extensionSource).toContain("transport: 'atomic-main-world-layout-correlated-click'")
  })

  it('clicks the correct repeated table action using the row identity from the open-source The Internet challenging-DOM pattern', async () => {
    // Minimal deterministic mirror of saucelabs/the-internet/views/challenging_dom.erb:
    // repeated edit/delete links inside otherwise locator-poor table rows.
    await withPage(`
      <!doctype html>
      <style>body{font:16px sans-serif} td{padding:8px 16px}</style>
      <table>
        <tbody>
          <tr><td>Iuvaret0</td><td><a href="#edit" data-row="row-0">edit</a> <a href="#delete">delete</a></td></tr>
          <tr><td>Iuvaret1</td><td><a href="#edit" data-row="row-1">edit</a> <a href="#delete">delete</a></td></tr>
          <tr><td>Iuvaret2</td><td><a href="#edit" data-row="row-2">edit</a> <a href="#delete">delete</a></td></tr>
        </tbody>
      </table>
      <script>
        globalThis.__clicked = ''
        document.querySelectorAll('a[href="#edit"]').forEach(link => link.addEventListener('click', event => {
          event.preventDefault()
          globalThis.__clicked = link.dataset.row
        }))
      </script>
    `, async page => {
      const result = await runCommand(page, 'click', {
        actionTokens: ['edit'],
        identityTokens: ['Iuvaret1'],
      })
      expect(result).toMatchObject({ ok: true, correlation: 'same-structured-row' })
      expect(await page.evaluate(() => (globalThis as any).__clicked)).toBe('row-1')
    })
  })

  it('clicks the correct title-backed action when identity and action live in separate fixed columns', async () => {
    await withPage(`
      <!doctype html>
      <style>
        body{font:16px sans-serif;margin:20px}
        .split-grid{display:grid;grid-template-columns:320px 220px;column-gap:24px;width:564px}
        .identity-column,.action-column{display:flex;flex-direction:column}
        .line{height:48px;display:flex;align-items:center;border-bottom:1px solid #ddd;box-sizing:border-box}
        .act_margin_left{cursor:pointer;display:inline-flex;padding:4px 10px}
      </style>
      <div class="split-grid">
        <div class="identity-column">
          <div class="line">运维机 A 10.192.3.249</div>
          <div class="line">方泽铭运维机 10.192.3.174</div>
        </div>
        <div class="action-column">
          <div class="line"><span class="act_margin_left" title="[RDP] [EMPTY]" data-host="10.192.3.249">[RDP] [EMPTY]</span></div>
          <div class="line"><span class="act_margin_left" title="[RDP] [EMPTY]" data-host="10.192.3.174">[RDP] [EMPTY]</span></div>
        </div>
      </div>
      <script>
        globalThis.__clicked = ''
        document.querySelectorAll('.act_margin_left').forEach(action => action.addEventListener('click', () => {
          globalThis.__clicked = action.dataset.host
        }))
      </script>
    `, async page => {
      const result = await runCommand(page, 'click', {
        actionTokens: ['RDP'],
        identityTokens: ['10.192.3.174'],
      })
      expect(result).toMatchObject({ ok: true, identityToken: '10.192.3.174', correlation: 'screen-row-alignment' })
      expect(await page.evaluate(() => (globalThis as any).__clicked)).toBe('10.192.3.174')
    })
  })

  it('fails closed instead of clicking the first action when row identity is genuinely ambiguous', async () => {
    await withPage(`
      <!doctype html>
      <style>body{font:16px sans-serif} td{padding:8px 16px}</style>
      <table><tbody>
        <tr><td>duplicate-device</td><td><button data-row="a">Open</button></td></tr>
        <tr><td>duplicate-device</td><td><button data-row="b">Open</button></td></tr>
      </tbody></table>
      <script>
        globalThis.__clicked = ''
        document.querySelectorAll('button').forEach(button => button.addEventListener('click', () => {
          globalThis.__clicked = button.dataset.row
        }))
      </script>
    `, async page => {
      const result = await runCommand(page, 'click', {
        actionTokens: ['Open'],
        identityTokens: ['duplicate-device'],
      })
      expect(result.ok).toBe(false)
      expect(String(result.error)).toContain('ambiguous')
      expect(await page.evaluate(() => (globalThis as any).__clicked)).toBe('')
    })
  })
})
