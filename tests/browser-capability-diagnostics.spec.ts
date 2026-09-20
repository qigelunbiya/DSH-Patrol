// @ts-nocheck
import { describe, expect, it } from 'vitest'
import {
  assertImageCodeCaptureCapability,
  registerImageCodeVisualTool,
} from '../browser-bridge-runtime/image-code-visual-tool.js'
import { issueImageCodeVisualAuthorization } from '../browser-bridge-runtime/image-code-visual-authorization.js'
import { registerTools } from '../browser-bridge-runtime/tools.js'

function fakeToolContext() {
  const definitions = []
  const services = new Map()
  return {
    definitions,
    ctx: {
      tools: {
        get(name) { return services.get(name) },
        async execute({ name }) {
          const tool = services.get(name)
          return await tool()
        },
        register(definition) {
          definitions.push(definition)
          return () => {}
        },
      },
      get() { return undefined },
    },
    services,
  }
}

describe('browser capability diagnostics', () => {
  it('renders captureImageCode support in browser_status', async () => {
    const fixture = fakeToolContext()
    const bridge = {
      status: () => ({
        connected: true,
        pending: 0,
        extension: {
          name: 'dsh-patrol-browser-extension',
          version: '0.2.1',
          capabilities: ['captureImageCode', 'visualSnapshot', 'semanticClick', 'visualClick'],
        },
      }),
      request: async () => ({ ok: true }),
      saveScreenshot: () => '/tmp/unused.png',
    }

    registerTools(fixture.ctx, bridge, { bridgeUrlHint: () => 'ws://127.0.0.1:3080/patrol-browser-bridge' })
    const status = fixture.definitions.find(definition => definition.name === 'browser_status')
    const value = await status.execute({}, {})
    const rendered = status.output.render({}, value).map(block => block.text || '').join('\n')

    expect(rendered).toContain('v0.2.1')
    expect(rendered).toContain('captureImageCode=yes')
    expect(rendered).toContain('semanticClick=yes')
    expect(rendered).toContain('visualClick=yes')
    expect(rendered).toContain('visualSnapshot')
  })

  it('sanitizes enriched snapshot metadata so context/evidence cannot invalidate browser_snapshot output', async () => {
    const fixture = fakeToolContext()
    const bridge = {
      status: () => ({
        connected: true,
        pending: 0,
        extension: {
          name: 'dsh-patrol-browser-extension',
          version: '0.3.1',
          capabilities: ['captureImageCode', 'visualSnapshot', 'semanticClick', 'visualClick'],
        },
      }),
      async request(cmd) {
        if (cmd !== 'snapshot') throw new Error(`unexpected ${cmd}`)
        return {
          ok: true,
          url: 'https://www.bilibili.com/',
          title: '哔哩哔哩',
          elements: [{
            tag: 'span',
            selector: 'top-frame::span[title="点赞"]',
            text: '点赞',
            context: '视频操作栏',
            evidence: 'title-backed-custom-action',
            unexpectedFutureField: 'must be dropped',
          }],
          truncated: false,
        }
      },
      saveScreenshot: () => '/tmp/unused.png',
    }

    registerTools(fixture.ctx, bridge)
    const snapshot = fixture.definitions.find(definition => definition.name === 'browser_snapshot')
    const value = await snapshot.execute({ maxElements: 50 }, {})
    expect(value.elements).toEqual([{
      tag: 'span',
      selector: 'top-frame::span[title="点赞"]',
      text: '点赞',
      context: '视频操作栏',
      evidence: 'title-backed-custom-action',
    }])
    expect(snapshot.output.schema.properties.elements.items.properties).toHaveProperty('context')
    expect(snapshot.output.schema.properties.elements.items.properties).toHaveProperty('evidence')
  })

  it('normalizes fractional browser scroll coordinates to the declared integer output schema', async () => {
    const fixture = fakeToolContext()
    const bridge = {
      status: () => ({ connected: true, pending: 0, extension: { capabilities: ['semanticClick'] } }),
      async request(cmd) {
        if (cmd === 'scroll') return { ok: true, x: 12.75, y: 345.49 }
        throw new Error(`unexpected ${cmd}`)
      },
      saveScreenshot: () => '/tmp/unused.png',
    }
    registerTools(fixture.ctx, bridge)
    const scroll = fixture.definitions.find(definition => definition.name === 'browser_scroll')
    const value = await scroll.execute({ direction: 'down', amount: 500 }, {})
    expect(value).toEqual({ ok: true, x: 13, y: 345 })
  })

  it('reports semanticClick as missing instead of treating a registered host tool as available', async () => {
    const fixture = fakeToolContext()
    const bridge = {
      status: () => ({
        connected: true,
        pending: 0,
        extension: {
          name: 'dsh-patrol-browser-extension',
          version: '0.3.0',
          capabilities: ['captureImageCode', 'visualSnapshot'],
        },
      }),
      request: async () => ({ ok: true }),
      saveScreenshot: () => '/tmp/unused.png',
    }

    registerTools(fixture.ctx, bridge)
    const status = fixture.definitions.find(definition => definition.name === 'browser_status')
    const value = await status.execute({}, {})
    const rendered = status.output.render({}, value).map(block => block.text || '').join('\n')

    expect(rendered).toContain('semanticClick=MISSING')
    expect(rendered).toContain('visualClick=MISSING')
    expect(rendered).toMatch(/selector fallback/i)
  })

  it('labels a connected extension without advertised capabilities as stale', async () => {
    const fixture = fakeToolContext()
    const bridge = {
      status: () => ({
        connected: true,
        pending: 0,
        extension: { name: 'dsh-patrol-browser-extension', version: '0.2.0' },
      }),
      request: async () => ({ ok: true }),
      saveScreenshot: () => '/tmp/unused.png',
    }

    registerTools(fixture.ctx, bridge)
    const status = fixture.definitions.find(definition => definition.name === 'browser_status')
    const value = await status.execute({}, {})
    const rendered = status.output.render({}, value).map(block => block.text || '').join('\n')

    expect(rendered).toContain('NOT_ADVERTISED')
    expect(rendered).toMatch(/will still try the legacy captureImageCode command/i)
  })

  it('allows legacy extensions without advertised capabilities to try captureImageCode', () => {
    expect(() => assertImageCodeCaptureCapability({
      status: () => ({ extension: { version: '0.2.0' } }),
    })).not.toThrow()
  })

  it('fails before captureImageCode when the live extension explicitly lacks the capability', () => {
    expect(() => assertImageCodeCaptureCapability({
      status: () => ({ extension: { version: '0.2.1', capabilities: ['visualSnapshot'] } }),
    })).toThrow(/runtime\/extension version mismatch/i)

    expect(() => assertImageCodeCaptureCapability({
      status: () => ({ extension: { version: '0.2.1', capabilities: ['captureImageCode'] } }),
    })).not.toThrow()
  })

  it('rejects CAPTCHA visual capture without an explicit local-OCR fallback authorization', async () => {
    const fixture = fakeToolContext()
    const bridge = {
      status: () => ({ extension: { version: '0.2.1', capabilities: ['captureImageCode'] } }),
      request: async () => { throw new Error('visual capture must not dispatch without authorization') },
      saveScreenshot: () => '/tmp/unused.png',
    }
    registerImageCodeVisualTool(fixture.ctx, bridge)
    const tool = fixture.definitions.find(definition => definition.name === 'browser_capture_image_code_visual')
    await expect(tool.execute({ fallbackToken: 'not-issued' }, { signal: new AbortController().signal }))
      .rejects.toThrow(/not authorized/i)
  })

  it('falls back to a full screenshot when an older extension does not support captureImageCode', async () => {
    const fixture = fakeToolContext()
    const calls = []
    const bridge = {
      status: () => ({ extension: { version: '0.2.0' } }),
      async request(cmd) {
        calls.push(cmd)
        if (cmd === 'captureImageCode') throw new Error('unsupported browser command: captureImageCode')
        if (cmd === 'screenshot') return { ok: true, dataUrl: 'data:image/png;base64,QUFB', bytes: 3 }
        throw new Error(`unexpected ${cmd}`)
      },
      saveScreenshot: () => '/tmp/current-page.png',
    }

    registerImageCodeVisualTool(fixture.ctx, bridge)
    const tool = fixture.definitions.find(definition => definition.name === 'browser_capture_image_code_visual')
    const value = await tool.execute({ fallbackToken: issueImageCodeVisualAuthorization() }, { agent: { session: { header: { cwd: '/tmp' } } }, signal: new AbortController().signal })

    expect(calls).toEqual(['captureImageCode', 'screenshot'])
    expect(value.captureMode).toBe('full-page-screenshot-fallback')
    expect(value.path).toBe('/tmp/current-page.png')
    expect(value.imageStatus).toBe('tool-unavailable')
    expect(value.imageError).toMatch(/unsupported browser command: captureImageCode/)
  })

  it('attaches only the read_image image payload to the CAPTCHA visual result', async () => {
    const fixture = fakeToolContext()
    fixture.services.set('read_image', async () => ({
      isError: false,
      value: {
        path: '/tmp/captcha.png',
        image: {
          attachmentId: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          mediaType: 'image/png',
          bytes: 3,
          width: 80,
          height: 24,
        },
      },
    }))
    const bridge = {
      status: () => ({ extension: { version: '0.2.1', capabilities: ['captureImageCode'] } }),
      async request(cmd) {
        if (cmd === 'captureImageCode') return { ok: true, dataUrl: 'data:image/png;base64,QUFB', captureMode: 'element-crop' }
        throw new Error(`unexpected ${cmd}`)
      },
      saveScreenshot: () => '/tmp/captcha.png',
    }

    registerImageCodeVisualTool(fixture.ctx, bridge)
    const tool = fixture.definitions.find(definition => definition.name === 'browser_capture_image_code_visual')
    const value = await tool.execute({ fallbackToken: issueImageCodeVisualAuthorization() }, { rootCallId: 'root', token: Symbol('visual'), agent: { session: { header: { cwd: '/tmp' } } }, signal: new AbortController().signal })
    const rendered = tool.output.render({}, value)

    expect(value.image).toMatchObject({ attachmentId: expect.stringMatching(/^sha256:/), mediaType: 'image/png' })
    expect(value.image.path).toBeUndefined()
    expect(rendered.find(block => block.type === 'image')?.attachment).toMatchObject({ attachmentId: expect.stringMatching(/^sha256:/) })
  })
})
