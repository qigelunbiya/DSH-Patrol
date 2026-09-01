import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { PatrolStore } from './store.js'

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

const CREDENTIAL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export function registerPatrolCredentialTools(ctx: Context, store: PatrolStore): () => void {
  const helper = defineTool({
    name: 'patrol_credential_help',
    description: 'Optional helper for users who explicitly want a Harness credential reference. Do NOT call this merely because a password was supplied in chat; patrol_type_transient now encrypts that supplied value for durable replay automatically.',
    parameters: {
      credentialRef: { type: 'string', required: true, description: 'Harness credential reference name such as IDC_LOGIN_PASSWORD.' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      if (!CREDENTIAL_NAME.test(args.credentialRef)) {
        throw new Error('credentialRef must be a POSIX-style identifier such as IDC_LOGIN_PASSWORD')
      }
      const credentials = ctx.get('credentials')
      if (credentials === undefined) throw new Error('Harness credential service is unavailable')
      const info = await credentials.describe(credentialRef(args.credentialRef))
      if (info.configured) {
        return `Credential ${args.credentialRef}: configured (${info.source ?? 'source hidden'}). Retry patrol_type_credential; the browser password field can be filled automatically without exposing the value.`
      }

      const helperPath = join(store.root, 'set-patrol-credential.ps1')
      return [
        `Credential ${args.credentialRef}: NOT configured.`,
        `Secure helper: ${helperPath}`,
        'This helper is optional. Use it only when you intentionally want a Harness credential reference instead of Patrol encrypted-secret storage.',
        'Run this once in PowerShell:',
        `& '${helperPath.replace(/'/g, "''")}' -Name '${args.credentialRef}'`,
        'The helper prompts for the secret with hidden input and stores it in the Harness credential store, not in the Patrol workspace or Runbook.',
        'Do not create a manual-login checkpoint just because this optional credential reference is missing.',
        'If the user already supplied the password in chat, do not stop here: use patrol_type_transient instead, which stores only encrypted ciphertext plus an opaque Runbook reference.',
      ].join('\n')
    },
  })

  const dispose = ctx.tools.register(helper)
  return () => dispose()
}
