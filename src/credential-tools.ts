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
    description: 'Check a Harness credential reference and, when missing, return the exact workspace-local secure setup helper command. This tool never accepts or reveals a credential value.',
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
        'Run this once in PowerShell:',
        `& '${helperPath.replace(/'/g, "''")}' -Name '${args.credentialRef}'`,
        'The helper prompts for the secret with hidden input and stores it in the Harness credential store, not in the Patrol workspace or Runbook.',
        'After it succeeds, retry patrol_type_credential. Do not create a manual-login checkpoint for an ordinary password field.',
      ].join('\n')
    },
  })

  const dispose = ctx.tools.register(helper)
  return () => dispose()
}
