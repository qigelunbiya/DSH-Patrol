// @ts-nocheck
import { describe, expect, it } from 'vitest'
import { assertImageCodeCaptureCapability } from '../browser-bridge-runtime/image-code-visual-tool.js'
import { registerTools } from '../browser-bridge-runtime/tools.js'

function fakeToolContext() {
  const definitions = []
  return {
    definitions,
    ctx: {
      tools: {
        register(definition) {
          definitions.push(definition)
          return () => {}
        },
      },
      get() { return undefined },
    },
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
    expect(rendered).toMatch(/older\/stale Patrol extension/i)
  })

  it('fails before captureImageCode when the live extension is stale or missing the capability', () => {
    expect(() => assertImageCodeCaptureCapability({
      status: () => ({ extension: { version: '0.2.0' } }),
    })).toThrow(/stale extension/i)

    expect(() => assertImageCodeCaptureCapability({
      status: () => ({ extension: { version: '0.2.1', capabilities: ['visualSnapshot'] } }),
    })).toThrow(/runtime\/extension version mismatch/i)

    expect(() => assertImageCodeCaptureCapability({
      status: () => ({ extension: { version: '0.2.1', capabilities: ['captureImageCode'] } }),
    })).not.toThrow()
  })
})
