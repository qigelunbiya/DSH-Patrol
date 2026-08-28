import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { registerPatrolCredentialTools } from '../src/credential-tools.ts'
import { PatrolStore } from '../src/store.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function setup(configured: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-credential-'))
  roots.push(root)
  const store = new PatrolStore(root)
  await store.init()

  const definitions: any[] = []
  const ctx = {
    tools: {
      register(definition: any) {
        definitions.push(definition)
        return () => {}
      },
    },
    get(name: string) {
      if (name !== 'credentials') return undefined
      return {
        async describe() {
          return { configured, source: configured ? 'local' : undefined, writable: true }
        },
      }
    },
  } as unknown as Context

  registerPatrolCredentialTools(ctx, store)
  const tool = definitions.find(item => item.name === 'patrol_credential_help')
  if (!tool) throw new Error('patrol_credential_help not registered')
  return { root, tool }
}

describe('Patrol credential setup helper', () => {
  it('does not expose a plaintext secret parameter', async () => {
    const { tool } = await setup(false)
    const schemaText = JSON.stringify(tool.parameters)
    expect(schemaText).toContain('credentialRef')
    expect(schemaText).not.toMatch(/"password"\s*:/i)
    expect(schemaText).not.toMatch(/"secret"\s*:/i)
    expect(schemaText).not.toMatch(/"value"\s*:/i)
    expect(schemaText).not.toMatch(/"text"\s*:/i)
  })

  it('returns the workspace-local hidden-input helper when a ref is missing', async () => {
    const { root, tool } = await setup(false)
    const result = await tool.execute({ credentialRef: 'IDC_LOGIN_PASSWORD' })
    expect(result).toContain('NOT configured')
    expect(result).toContain(join(root, 'set-patrol-credential.ps1'))
    expect(result).toContain("-Name 'IDC_LOGIN_PASSWORD'")
    expect(result).toContain('hidden input')
    expect(result).toContain('Do not create a manual-login checkpoint')
  })

  it('tells Patrol to retry automatic credential typing when configured', async () => {
    const { tool } = await setup(true)
    const result = await tool.execute({ credentialRef: 'IDC_LOGIN_PASSWORD' })
    expect(result).toContain('configured')
    expect(result).toContain('Retry patrol_type_credential')
    expect(result).not.toContain('set-patrol-credential.ps1')
  })

  it('rejects invalid reference names', async () => {
    const { tool } = await setup(false)
    await expect(tool.execute({ credentialRef: 'bad ref' })).rejects.toThrow(/POSIX-style identifier/i)
  })
})
