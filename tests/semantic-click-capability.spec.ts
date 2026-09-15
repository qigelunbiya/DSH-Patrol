// @ts-nocheck
import { describe, expect, it } from 'vitest'
import { registerSemanticClickTool } from '../browser-bridge-runtime/semantic-click-tool.js'

describe('semantic click capability gate', () => {
  it('fails fast without sending an unsupported command to a stale extension', async () => {
    const definitions = []
    const requests = []
    const ctx = { tools: { register(tool) { definitions.push(tool); return () => {} } } }
    const bridge = {
      status: () => ({ extension: { version: '0.3.0', capabilities: ['captureImageCode'] } }),
      async request(command) { requests.push(command); return { ok: true, selector: '#login' } },
    }
    registerSemanticClickTool(ctx, bridge)
    const tool = definitions.find(item => item.name === 'browser_semantic_click')

    await expect(tool.execute({ selectorHint: '#login', locatorText: '登录' }, {}))
      .rejects.toThrow(/semanticClick capability is missing/i)
    expect(requests).toEqual([])
  })

  it('keeps legacy no-capability handshakes compatible', async () => {
    const definitions = []
    const requests = []
    const ctx = { tools: { register(tool) { definitions.push(tool); return () => {} } } }
    const bridge = {
      status: () => ({ extension: { version: '0.2.0' } }),
      async request(command) { requests.push(command); return { ok: true, selector: '#login' } },
    }
    registerSemanticClickTool(ctx, bridge)
    const tool = definitions.find(item => item.name === 'browser_semantic_click')

    await expect(tool.execute({ selectorHint: '#login', locatorText: '登录' }, {}))
      .resolves.toMatchObject({ ok: true, selector: '#login' })
    expect(requests).toEqual(['semanticClick'])
  })

  it('delegates a verified custom action target to managed Puppeteer trusted input', async () => {
    const definitions = []
    const trustedCalls = []
    const ctx = { tools: { register(tool) { definitions.push(tool); return () => {} } } }
    const bridge = {
      status: () => ({ extension: { version: '0.3.1', capabilities: ['semanticClick'] } }),
      async request(command) {
        expect(command).toBe('semanticClick')
        return {
          ok: true,
          selector: 'top-frame::span[title="详情"]',
          text: '详情',
          role: 'button',
          tag: 'span',
          frameId: 0,
          frameUrl: 'https://example.test/app',
          pageUrl: 'https://example.test/app#hosts',
          trustedClickRequired: true,
          trustedSelector: 'span[title="详情"]',
          transport: 'host-trusted-click-target',
        }
      },
    }
    registerSemanticClickTool(ctx, bridge, {
      trustedClick: async spec => {
        trustedCalls.push(spec)
        return { ok: true, transport: 'puppeteer-trusted-click' }
      },
    })
    const tool = definitions.find(item => item.name === 'browser_semantic_click')

    const result = await tool.execute({ locatorText: '详情', task: '打开主机 alpha-01 的详情' }, {})
    expect(trustedCalls).toEqual([{
      selector: 'span[title="详情"]',
      pageUrl: 'https://example.test/app#hosts',
      frameUrl: 'https://example.test/app',
      frameId: 0,
    }])
    expect(result).toMatchObject({
      ok: true,
      selector: 'top-frame::span[title="详情"]',
      transport: 'puppeteer-trusted-click',
    })
  })
})
