import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const management = readFileSync(join(process.cwd(), 'browser-bridge-runtime', 'dashboard-management-client.js'), 'utf8')
const host = readFileSync(join(process.cwd(), 'client-host-runtime', 'client.js'), 'utf8')
const executeRoute = readFileSync(join(process.cwd(), 'browser-bridge-runtime', 'dashboard-execute.js'), 'utf8')

describe('flow run button', () => {
  it('executes the stable flow id through the deterministic dashboard endpoint', () => {
    expect(management).toContain('data-manage-action="run"')
    expect(management).toContain("postAction('/execute'")
    expect(management).toContain('parentSessionId: SESSION')
    expect(management).not.toContain("type: 'dsh-patrol:run-flow'")
    expect(management).not.toContain('window.parent.postMessage')
  })

  it('passes the originating Patrol session id into the same-origin dashboard iframe', () => {
    expect(host).toContain('function DashboardFrame({ useSession, workspaceRoot, sessionId, mode })')
    expect(host).toContain("params.set('session', sessionId)")
    expect(host).toContain('sessionId,')
    expect(host).not.toContain('runFlowInFreshPatrolSession')
    expect(host).not.toContain('binding.session.prompt')
  })

  it('runs deterministically first and invokes the recovery model only after a failed report', () => {
    expect(executeRoute).toContain("executeTool(tools, handle.agent, 'patrol_run_flow'")
    expect(executeRoute).toContain("if (initialStatus !== 'failed')")
    expect(executeRoute).toContain("executeTool(tools, handle.agent, 'patrol_recover'")
    expect(executeRoute).toContain('Runbook was NOT modified')
  })
})
