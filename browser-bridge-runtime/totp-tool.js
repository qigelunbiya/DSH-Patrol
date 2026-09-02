import { defineTool } from '@deepseek-ai/dsh-tools'
import { generateTotpForProfile } from './totp-store.js'

const reqStr = { type: 'string', required: true }
const reqBool = { type: 'boolean', required: true }
const str = { type: 'string' }
const int = { type: 'integer' }
const optInt = { type: 'integer' }
const optBool = { type: 'boolean' }

export function registerTotpTool(ctx, bridge, config = {}) {
  const timeoutMs = config.commandTimeoutMs ?? 60000
  const minimumValiditySeconds = clampInteger(config.minimumValiditySeconds, 5, 2, 10)
  const definition = defineTool({
    name: 'browser_type_totp_profile',
    description: 'Generate and type the CURRENT TOTP for an already configured Patrol token profile. The TOTP seed and generated digits never appear in tool arguments, tool output, Runbook text, or model-visible content. Near the end of a TOTP period this waits for the next time slice before typing.',
    parameters: {
      selector: reqStr,
      profileId: reqStr,
      clear: optBool,
      tabId: optInt,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: reqBool,
          selector: reqStr,
          profileId: reqStr,
          issuer: str,
          account: str,
          algorithm: str,
          digits: int,
          period: int,
          validForSeconds: int,
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Typed a freshly generated TOTP from profile ${value.profileId} into ${value.selector}. The dynamic code was not exposed.`,
      }],
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Type TOTP profile',
      kind: 'other',
      rawInput: { selector: args.selector, profileId: args.profileId, clear: args.clear, tabId: args.tabId },
    }),
    async execute(args, exec) {
      const generated = await stableTotp(args.profileId, minimumValiditySeconds, {
        signal: exec?.signal,
        now: config.now,
        sleep: config.sleep,
      })
      try {
        const typed = await bridge.request('type', {
          selector: args.selector,
          text: generated.code,
          clear: args.clear ?? true,
          tabId: args.tabId,
        }, { timeoutMs, signal: exec?.signal })
        if (!typed || typeof typed !== 'object' || typed.ok === false) {
          throw new Error('browser typing returned an invalid response')
        }
      } catch {
        // Never include the generated digits or an extension error that might
        // echo input text. The profile id/selector are the only safe context.
        throw new Error(`Could not type the current TOTP from profile ${args.profileId} into ${args.selector}`)
      }

      return {
        ok: true,
        selector: args.selector,
        profileId: args.profileId,
        issuer: generated.profile.issuer,
        account: generated.profile.account,
        algorithm: generated.profile.algorithm,
        digits: generated.profile.digits,
        period: generated.profile.period,
        validForSeconds: generated.validForSeconds,
      }
    },
  })

  return ctx.tools.register(definition)
}

export async function stableTotp(profileId, minimumValiditySeconds = 5, options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now
  const sleep = typeof options.sleep === 'function'
    ? options.sleep
    : ms => new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms)
        if (options.signal) {
          if (options.signal.aborted) {
            clearTimeout(timer)
            reject(new Error('TOTP generation was aborted'))
            return
          }
          options.signal.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(new Error('TOTP generation was aborted'))
          }, { once: true })
        }
      })
  const minValidity = clampInteger(minimumValiditySeconds, 5, 2, 10)
  let generated = generateTotpForProfile(profileId, now())
  if (generated.validForSeconds > minValidity) return generated

  await sleep((generated.validForSeconds * 1000) + 250)
  generated = generateTotpForProfile(profileId, now())
  return generated
}

function clampInteger(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isInteger(number)) return fallback
  return Math.max(min, Math.min(max, number))
}
