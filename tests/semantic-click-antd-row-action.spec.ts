import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveBrowserExecutable } from '../browser-bridge-runtime/managed-browser.js'

const root = process.cwd()
const semanticPath = join(root, 'browser-extension', 'semantic-click.js')
const semanticSource = readFileSync(semanticPath, 'utf8')
const marker = 'async function semanticClickPageCommand(mode, spec) {'
const markerIndex = semanticSource.indexOf(marker)
if (markerIndex < 0) throw new Error('semantic click page command marker is missing')
const pageCommandSource = semanticSource.slice(markerIndex).trim()

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

describe('core semantic click for Ant Design title-backed row actions', () => {
  it('preserves targetContext across the extension command boundary', () => {
    expect(semanticSource).toContain("'targetContext'")
    expect(semanticSource).toContain('spec.targetContext')
  })

  it('opens the correct login modal from the exact repeated RDP span shape even when role=link was guessed', async () => {
    await withPage(`
      <!doctype html>
      <style>
        body { font: 14px sans-serif; }
        table { width: 900px; border-collapse: collapse; }
        td { height: 42px; padding: 0 12px; }
        .act_margin_left { cursor: pointer; display: inline-block; padding: 5px 8px; }
        .ant-modal-content { margin-top: 20px; padding: 16px; border: 1px solid #aaa; }
      </style>
      <table><tbody class="ant-table-tbody">
        <tr data-row-key="388_5013_1_RDP_[EMPTY]" class="ant-table-row ant-table-row-level-0">
          <td title="10.192.3.249">10.192.3.249</td>
          <td title="10.192.3.249">10.192.3.249</td>
          <td title="Windows">Windows</td>
          <td class="ant-table-cell ant-table-cell-fix-right">
            <span class="ant-table-cell-content"><div class="account_box"><span class="account_now">
              <span><span title="[RDP] [EMPTY]" class="act_margin_left">[RDP] [EMPTY]</span></span>
            </span></div></span>
          </td>
        </tr>
        <tr data-row-key="5860_6066_1_RDP_[EMPTY]" class="ant-table-row ant-table-row-level-0">
          <td title="方泽铭运维机">方泽铭运维机</td>
          <td title="10.192.3.174">10.192.3.174</td>
          <td title="Windows">Windows</td>
          <td class="ant-table-cell ant-table-cell-fix-right">
            <span class="ant-table-cell-content"><div class="account_box"><span class="account_now">
              <span><span title="[RDP] [EMPTY]" class="act_margin_left">[RDP] [EMPTY]</span></span>
            </span></div></span>
          </td>
        </tr>
      </tbody></table>
      <div id="modal-root"></div>
      <script>
        document.querySelectorAll('.account_now').forEach(parent => {
          parent.addEventListener('click', event => {
            if (!event.target.closest('.act_margin_left')) return
            const row = parent.closest('tr')
            const host = row.querySelector('td[title^="10."]').getAttribute('title')
            document.querySelector('#modal-root').innerHTML = [
              '<div class="ant-modal-content">',
              '<div class="ant-modal-title">运维登录</div>',
              '<div class="host-ip">' + host + '</div>',
              '<div>RDP</div>',
              '<input id="loginName" type="text">',
              '<input id="password" type="password">',
              '<button type="button"><span>确 定</span></button>',
              '</div>',
            ].join('')
          })
        })
      </script>
    `, async page => {
      const result = await runCommand(page, 'click', {
        locatorText: 'RDP',
        // This reproduces the live failure: the model guessed link although the
        // real current target is a role-less span.
        locatorRole: 'link',
        task: '点击 10.192.3.174 的 RDP 按钮',
        targetContext: '目标主机 10.192.3.174 的 RDP 访问方式',
      })

      expect(result).toMatchObject({ ok: true, tag: 'span' })
      expect(String(result.selector)).toContain('data-row-key="5860_6066_1_RDP_[EMPTY]"')
      expect(String(result.selector)).toContain('title="[RDP] [EMPTY]"')
      expect(await page.$eval('.ant-modal-title', element => element.textContent)).toBe('运维登录')
      expect(await page.$eval('.host-ip', element => element.textContent)).toBe('10.192.3.174')
    })
  })

  it('keeps repeated actions fail-closed when the target row identity does not distinguish them', async () => {
    await withPage(`
      <!doctype html>
      <style>td{height:42px}.act_margin_left{display:inline-block;padding:4px;cursor:pointer}</style>
      <table><tbody>
        <tr data-row-key="a"><td>same-host</td><td><span title="[RDP] [EMPTY]" class="act_margin_left">[RDP] [EMPTY]</span></td></tr>
        <tr data-row-key="b"><td>same-host</td><td><span title="[RDP] [EMPTY]" class="act_margin_left">[RDP] [EMPTY]</span></td></tr>
      </tbody></table>
    `, async page => {
      const result = await runCommand(page, 'probe', {
        locatorText: 'RDP',
        task: '点击 same-host 的 RDP',
        targetContext: 'same-host',
      })
      expect(result.ok).toBe(true)
      expect(Array.isArray(result.candidates)).toBe(true)
      expect(result.candidates).toHaveLength(2)
      expect(result.candidates[0].score).toBe(result.candidates[1].score)
    })
  })
})
