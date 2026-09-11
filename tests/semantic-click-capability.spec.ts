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
})
