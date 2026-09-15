import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveBrowserExecutable } from '../browser-bridge-runtime/managed-browser.js'

const root = process.cwd()
const source = readFileSync(join(root, 'browser-extension', 'title-backed-row-action-hardening.js'), 'utf8')
const entry = readFileSync(join(root, 'browser-extension', 'background-entry.js'), 'utf8')
const marker = 'function titleBackedRowActionPageCommand(mode, spec) {'
const markerIndex = source.indexOf(marker)
if (markerIndex < 0) throw new Error('title-backed page command marker is missing')
const pageCommandSource = source.slice(markerIndex).trim()

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

async function runCommand(page: Page, mode: 'probe' | 'click', spec: Record<string, unknown>): Promise<any> {
  return await page.evaluate(({ source, mode, spec }) => {
    const command = (0, eval)(`(${source})`)
    return command(mode, spec)
  }, { source: pageCommandSource, mode, spec })
}

describe('title-backed row action interaction owner', () => {
  it('runs before the generic geometry fallback for title-backed actions', () => {
    const titleIndex = entry.indexOf("importScripts('generic-title-row-action-hardening.js')")
    const layoutIndex = entry.indexOf("importScripts('semantic-layout-row-action.js')")
    expect(layoutIndex).toBeGreaterThan(-1)
    expect(titleIndex).toBeGreaterThan(layoutIndex)
  })

  it('clicks the Ant-style wrapper that owns the action and opens the modal for the requested host', async () => {
    await withPage(`
      <!doctype html>
      <style>
        body { font: 14px sans-serif; }
        td { padding: 8px 12px; }
        .account_now { cursor: pointer; display: inline-flex; }
        .act_margin_left { margin-left: 6px; }
        .ant-modal-content { border: 1px solid #ddd; padding: 12px; margin-top: 12px; }
      </style>
      <table><tbody class="ant-table-tbody">
        <tr data-row-key="388_5013_1_RDP_[EMPTY]" class="ant-table-row ant-table-row-level-0">
          <td title="10.192.3.249">10.192.3.249</td>
          <td title="10.192.3.249">10.192.3.249</td>
          <td title="Windows">Windows</td>
          <td class="ant-table-cell ant-table-cell-fix-right">
            <span class="ant-table-cell-content"><div class="account_box">
              <span class="account_now" data-host="10.192.3.249"><span><span aria-label="global">◎</span><span title="[RDP] [EMPTY]" class="act_margin_left">[RDP] [EMPTY]</span></span></span>
              <span aria-label="down">⌄</span>
            </div></span>
          </td>
        </tr>
        <tr data-row-key="5860_6066_1_RDP_[EMPTY]" class="ant-table-row ant-table-row-level-0">
          <td title="方泽铭运维机">方泽铭运维机</td>
          <td title="10.192.3.174">10.192.3.174</td>
          <td title="Windows">Windows</td>
          <td class="ant-table-cell ant-table-cell-fix-right">
            <span class="ant-table-cell-content"><div class="account_box">
              <span class="account_now" data-host="10.192.3.174"><span><span aria-label="global">◎</span><span title="[RDP] [EMPTY]" class="act_margin_left">[RDP] [EMPTY]</span></span></span>
              <span aria-label="down">⌄</span>
            </div></span>
          </td>
        </tr>
      </tbody></table>
      <div id="modal-root"></div>
      <script>
        document.querySelectorAll('.account_now').forEach(owner => {
          owner.addEventListener('click', event => {
            // Emulate an enterprise widget whose wrapper is the true hit target.
            // Clicking only the nested title label is deliberately ignored.
            if (event.target !== owner) return
            document.querySelector('#modal-root').innerHTML =
              '<div class="ant-modal-content"><div class="ant-modal-title">运维登录</div>' +
              '<div><label>主机IP</label><span>' + owner.dataset.host + '</span></div>' +
              '<div><label>协议</label><span>RDP</span></div></div>'
          })
        })
      </script>
    `, async page => {
      const result = await runCommand(page, 'click', {
        identityTokens: ['10.192.3.174'],
        actionTokens: ['RDP'],
      })

      expect(result).toMatchObject({ ok: true, correlation: 'same-row' })
      expect(String(result.selector)).toContain('account_now')
      const modalText = await page.$$eval('.ant-modal-content', nodes => nodes.map(node => node.textContent || '').join('\n'))
      expect(modalText).toContain('10.192.3.174')
      expect(modalText).toContain('运维登录')
      expect(modalText).toContain('RDP')
    })
  })

  it('keeps repeated title actions fail-closed when no unique row identity exists', async () => {
    await withPage(`
      <!doctype html>
      <style>.account_now{cursor:pointer}</style>
      <table><tbody>
        <tr><td>duplicate</td><td><span class="account_now"><span title="[RDP] [EMPTY]">[RDP] [EMPTY]</span></span></td></tr>
        <tr><td>duplicate</td><td><span class="account_now"><span title="[RDP] [EMPTY]">[RDP] [EMPTY]</span></span></td></tr>
      </tbody></table>
    `, async page => {
      const result = await runCommand(page, 'click', {
        identityTokens: ['duplicate'],
        actionTokens: ['RDP'],
      })
      expect(result.ok).toBe(false)
      expect(String(result.error)).toContain('ambiguous')
    })
  })
})
