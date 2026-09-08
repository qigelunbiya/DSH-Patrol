// @ts-nocheck
import { describe, expect, it } from 'vitest'
import {
  assertImageCodeCaptureCapability,
  registerImageCodeVisualTool,
} from '../browser-bridge-runtime/image-code-visual-tool.js'
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
          capabilities: ['captureImageCode', 'visualSnapshot'],
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
    expect(rendered).toContain('visualSnapshot')
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
    const value = await tool.execute({}, { agent: { session: { header: { cwd: '/tmp' } } }, signal: new AbortController().signal })

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
    const value = await tool.execute({}, { rootCallId: 'root', token: Symbol('visual'), agent: { session: { header: { cwd: '/tmp' } } }, signal: new AbortController().signal })
    const rendered = tool.output.render({}, value)

    expect(value.image).toMatchObject({ attachmentId: expect.stringMatching(/^sha256:/), mediaType: 'image/png' })
    expect(value.image.path).toBeUndefined()
    expect(rendered.find(block => block.type === 'image')?.attachment).toMatchObject({ attachmentId: expect.stringMatching(/^sha256:/) })
  })
})
