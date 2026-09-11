import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const source = readFileSync(join(process.cwd(), 'browser-extension', 'semantic-intent-fallback.js'), 'utf8')

function wrap(base: (cmd: string, args?: any) => Promise<any>) {
  return new Function('handleCommand', `${source}\nreturn handleCommand`)(base) as typeof base
}

describe('semantic intent fallback', () => {
  it('retries an explicit Logo target once without a misleading observed text label', async () => {
    const base = vi.fn(async (_cmd: string, args: any = {}) => {
      if (args.locatorText) throw new Error('atomic semantic target not found for synthetic logo')
      return { ok: true, selector: 'top-frame::img.logo' }
    })
    const command = wrap(base)

    await expect(command('semanticClick', {
      task: '点击 Logo 进入登录页面',
      locatorText: '长城网际',
    })).resolves.toMatchObject({ ok: true, selector: 'top-frame::img.logo' })

    expect(base).toHaveBeenCalledTimes(2)
    expect(base.mock.calls[0]?.[1]).toMatchObject({ locatorText: '长城网际' })
    expect(base.mock.calls[1]?.[1]).toMatchObject({ task: '点击 Logo 进入登录页面' })
    expect(base.mock.calls[1]?.[1].locatorText).toBeUndefined()
  })

  it('does not relax ambiguity or ordinary non-logo targets', async () => {
    const ambiguous = vi.fn(async () => { throw new Error('atomic semantic target is ambiguous (2 equally ranked candidates)') })
    await expect(wrap(ambiguous)('semanticClick', { task: '点击 Logo', locatorText: '品牌' }))
      .rejects.toThrow(/ambiguous/)
    expect(ambiguous).toHaveBeenCalledTimes(1)

    const ordinary = vi.fn(async () => { throw new Error('atomic semantic target not found') })
    await expect(wrap(ordinary)('semanticClick', { task: '点击登录', locatorText: '登录' }))
      .rejects.toThrow(/not found/)
    expect(ordinary).toHaveBeenCalledTimes(1)
  })
})
