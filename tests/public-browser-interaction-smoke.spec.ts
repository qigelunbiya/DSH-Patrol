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
      response.end(`<!doctype html><a href="#blank" style="display:inline-block;width:10px;height:10px"></a><button id="add" onclick="this.insertAdjacentHTML('afterend','<button class=added onclick=this.remove()>Delete</button>')">Add Element</button>`)
      return
    }
    if (request.url === '/dropdown') {
      response.end('<!doctype html><select id="dropdown"><option value="">Please select</option><option value="1">Option 1</option><option value="2">Option 2</option></select>')
      return
    }
    if (request.url === '/menu') {
      response.end('<!doctype html><a class="hamburger" href="#menu" aria-label="打开侧栏菜单" style="display:inline-block;width:10px;height:10px"><span></span></a><a href="#other" style="display:inline-block;width:10px;height:10px"><span></span></a>')
      return
    }
    if (request.url === '/visual') {
      response.end('<!doctype html><button id="target" style="position:fixed;left:432px;top:311px;width:56px;height:28px" oncontextmenu="this.dataset.context=\'yes\';event.preventDefault()">发布</button>')
      return
    }
    if (request.url === '/visual-card') {
      response.end(`<!doctype html>
        <style>
          body{margin:0}
          .card{position:fixed;left:300px;top:220px;width:260px;height:130px;cursor:pointer}
          #real{position:absolute;left:0;top:0;width:240px;height:110px;display:block;background:#ddd}
          #cover{position:absolute;left:82px;top:0;width:100px;height:110px;z-index:3;background:rgba(0,0,0,.01)}
        </style>
        <div class="card">
          <a id="real" href="/detail">普通视频卡片</a>
          <div id="cover"></div>
        </div>`)
      return
    }
    if (request.url === '/detail') {
      response.end('<!doctype html><title>目标视频</title><h1>普通视频卡片</h1>')
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
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 })

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
      expect(harness.manifest.version).toBe('0.3.12')
      await harness.page.goto(`${site.root}/add_remove_elements/`, { waitUntil: 'domcontentloaded', timeout: 20000 })

      const boundedShot = await harness.command('screenshot', { format: 'jpeg', maxWidth: 1024, quality: 68, coordinateGuide: true })
      expect(boundedShot.compactVisual).toBe(true)
      expect(boundedShot.coordinateGuide).toBe(true)
      expect(boundedShot.coordinateGridUnits).toBe(1000)
      expect(boundedShot.modelRasterWidth).toBeLessThanOrEqual(1024)
      expect(boundedShot.ocrDataUrl).toMatch(/^data:image\/jpeg;base64,/)
      expect(boundedShot.dataUrl).not.toBe(boundedShot.ocrDataUrl)
      const boundedDimensions = await harness.page.evaluate(async dataUrl => {
        const image = new Image()
        image.decoding = 'async'
        const loaded = new Promise((resolve, reject) => {
          image.onload = () => resolve(true)
          image.onerror = () => reject(new Error('smoke screenshot decode failed'))
        })
        image.src = dataUrl
        await loaded
        return { width: image.naturalWidth, height: image.naturalHeight }
      }, boundedShot.dataUrl)
      expect(boundedDimensions.width).toBeLessThanOrEqual(1024)
      expect(boundedDimensions.width).toBeGreaterThan(0)

      await harness.page.goto(`${site.root}/visual`, { waitUntil: 'domcontentloaded', timeout: 20000 })
      const visualShot = await harness.command('screenshot', { format: 'jpeg', maxWidth: 1024, quality: 68, coordinateGuide: true })
      const xRatio = 460 / 1280
      const yRatio = 325 / 800
      const marked = await harness.command('visualClick', {
        frameId: visualShot.visualFrameId,
        xRatio,
        yRatio,
        targetHint: '发布按钮',
        visualAuthority: true,
        pointerAction: 'mark',
      })
      expect(marked).toMatchObject({ ok: true, pointerAction: 'mark', visualSnapped: false })
      expect(await harness.page.$('#__dsh_patrol_visual_marker')).not.toBeNull()

      const rightClicked = await harness.command('visualClick', {
        frameId: visualShot.visualFrameId,
        xRatio,
        yRatio,
        targetHint: '发布按钮',
        visualAuthority: true,
        pointerAction: 'right-click',
      })
      expect(rightClicked).toMatchObject({ ok: true, pointerAction: 'right-click', visualSnapped: false })
      expect(await harness.page.$eval('#target', element => element.dataset.context)).toBe('yes')

      // Small controls use a second, focused visual frame. The crop is rendered
      // at high resolution, but its xRatio/yRatio stay local to the crop and
      // are projected through captureClientLeft/Top/Width/Height.
      await harness.page.$eval('#target', element => { delete element.dataset.context })
      const focusedShot = await harness.command('screenshot', {
        format: 'jpeg',
        maxWidth: 1024,
        quality: 78,
        actionMap: true,
        focusXRatio: 460 / 1280,
        focusYRatio: 325 / 800,
        focusWidthRatio: 0.25,
        focusHeightRatio: 0.30,
      })
      expect(focusedShot).toMatchObject({
        focusedVisual: true,
        captureMode: 'cdp-focused-region',
        actionMap: true,
        actionCandidateCount: 1,
      })
      expect(focusedShot.coordinateGuide).toBe(false)
      expect(focusedShot.captureWidth).toBeCloseTo(320, 0)
      expect(focusedShot.captureHeight).toBeCloseTo(240, 0)
      expect(focusedShot.modelRasterWidth).toBeLessThanOrEqual(1024)
      expect(focusedShot.modelRasterWidth).toBeGreaterThan(600)

      const focusedRightClick = await harness.command('visualClick', {
        frameId: focusedShot.visualFrameId,
        candidateId: 'A1',
        targetHint: '发布按钮',
        visualAuthority: true,
        pointerAction: 'right-click',
      })
      expect(focusedRightClick).toMatchObject({
        ok: true,
        candidateId: 'A1',
        pointerAction: 'right-click',
        targetTag: 'button',
        targetText: '发布',
        visualSnapped: false,
      })
      expect(await harness.page.$eval('#target', element => element.dataset.context)).toBe('yes')

      await harness.page.goto(`${site.root}/visual-card`, { waitUntil: 'domcontentloaded', timeout: 20000 })
      const cardShot = await harness.command('screenshot', {
        format: 'jpeg',
        maxWidth: 1024,
        quality: 78,
        actionMap: true,
      })
      expect(cardShot).toMatchObject({
        actionMap: true,
        actionCandidateCount: 1,
      })
      const cardClick = await harness.command('visualClick', {
        frameId: cardShot.visualFrameId,
        candidateId: 'A1',
        targetHint: '普通视频卡片',
        expectedVisualText: '普通视频卡片',
        visualAuthority: true,
      })
      expect(cardClick).toMatchObject({
        ok: true,
        candidateId: 'A1',
        actionCandidateKind: 'anchor',
        actionCandidateSafePoint: expect.stringMatching(/^verified-hit:/),
        visualSnapped: false,
      })
      await harness.page.waitForFunction(() => location.pathname === '/detail', { timeout: 5000 })
      expect(harness.page.url()).toContain('/detail')

      await harness.page.goto(`${site.root}/add_remove_elements/`, { waitUntil: 'domcontentloaded', timeout: 20000 })

      await expect(harness.command('semanticClick', {
        locatorText: 'Missing target',
        task: '点击不存在的目标',
      })).rejects.toThrow(/target not found|ambiguous/i)

      // The business target is resolved and clicked inside one extension command,
      // exactly like patrol_click_target now does. No snapshot selector is fed
      // back into the semantic click path.
      const semantic = await harness.command('semanticClick', {
        locatorText: 'Add Element',
        locatorRole: 'button',
        task: 'Click Add Element',
      })
      expect(semantic).toMatchObject({ ok: true, role: 'button' })
      expect(semantic.transport).toMatch(/^atomic-(?:main-world-semantic-click|semantic\+trusted-native-mouse)$/)
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

      await harness.page.goto(`${site.root}/menu`, { waitUntil: 'domcontentloaded', timeout: 20000 })
      await new Promise(resolve => setTimeout(resolve, 300))
      const menu = await harness.command('semanticClick', { task: '打开侧栏菜单' })
      expect(menu.selector).toContain('aria-label="打开侧栏菜单"')
    } finally {
      await harness.browser.close()
      await site.close()
    }
  }, 60000)
})
