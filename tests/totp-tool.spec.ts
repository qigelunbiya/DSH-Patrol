import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { clearTransientSecrets } from '../browser-bridge-runtime/transient-secret-store.js'
import { saveTotpProfileFromUri } from '../browser-bridge-runtime/totp-store.js'
import { registerTotpTool } from '../browser-bridge-runtime/totp-tool.js'
import { isReplayableBrowserTool, isSafeBrowserTool } from '../src/browser.js'

const roots: string[] = []
const previousTotp = process.env.DSH_PATROL_TOTP_DIR
const previousSecret = process.env.DSH_PATROL_SECRET_DIR

afterEach(async () => {
  clearTransientSecrets()
  if (previousTotp === undefined) delete process.env.DSH_PATROL_TOTP_DIR
  else process.env.DSH_PATROL_TOTP_DIR = previousTotp
  if (previousSecret === undefined) delete process.env.DSH_PATROL_SECRET_DIR
  else process.env.DSH_PATROL_SECRET_DIR = previousSecret
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function configureProfile() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-totp-tool-'))
  roots.push(root)
  process.env.DSH_PATROL_TOTP_DIR = join(root, 'profiles')
  process.env.DSH_PATROL_SECRET_DIR = join(root, 'secrets')
  clearTransientSecrets()
  saveTotpProfileFromUri(
    'ops-login',
    'otpauth://totp/Operations:alice?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Operations&digits=6&period=30',
  )
}

describe('browser TOTP profile input', () => {
  it('types generated digits internally while exposing only the profile id and metadata', async () => {
    await configureProfile()
    let definition: any
    let typedText = ''
    const ctx = {
      tools: {
        register(value: any) {
          definition = value
          return () => {}
        },
      },
    }
    const bridge = {
      async request(cmd: string, args: any) {
        expect(cmd).toBe('type')
        typedText = args.text
        return { ok: true }
      },
    }

    registerTotpTool(ctx, bridge, {
      now: () => 10_000,
      sleep: async () => {},
    })
    const result = await definition.execute({ selector: '#otp', profileId: 'ops-login' }, {})
    const rendered = definition.output.render({}, result).map((block: any) => block.text || '').join('\n')

    expect(typedText).toMatch(/^\d{6}$/)
    expect(result).toMatchObject({ ok: true, selector: '#otp', profileId: 'ops-login', issuer: 'Operations' })
    expect(result).not.toHaveProperty('code')
    expect(rendered).not.toContain(typedText)
    expect(rendered).not.toContain('GEZDGNBV')
  })

  it('waits out a nearly expired time slice before generating the value to type', async () => {
    await configureProfile()
    let definition: any
    const nowValues = [29_000, 30_250]
    const sleeps: number[] = []
    let typedText = ''
    const ctx = { tools: { register(value: any) { definition = value; return () => {} } } }
    const bridge = {
      async request(_cmd: string, args: any) {
        typedText = args.text
        return { ok: true }
      },
    }

    registerTotpTool(ctx, bridge, {
      minimumValiditySeconds: 5,
      now: () => nowValues.shift() ?? 30_250,
      sleep: async (ms: number) => { sleeps.push(ms) },
    })
    const result = await definition.execute({ selector: '#otp', profileId: 'ops-login' }, {})

    expect(sleeps).toEqual([1250])
    expect(typedText).toMatch(/^\d{6}$/)
    expect(result.validForSeconds).toBeGreaterThan(5)
  })

  it('is safe and replayable by opaque token profile reference', () => {
    expect(isSafeBrowserTool('browser_type_totp_profile')).toBe(true)
    expect(isReplayableBrowserTool('browser_type_totp_profile')).toBe(true)
  })
})
