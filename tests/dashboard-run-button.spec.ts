import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const managementClient = readFileSync(join(process.cwd(), 'browser-bridge-runtime', 'dashboard-management-client.js'), 'utf8')
const managementHost = readFileSync(join(process.cwd(), 'browser-bridge-runtime', 'dashboard-management.js'), 'utf8')

describe('flow run button', () => {
  it('posts the stable flow id directly to the host replay route instead of a conversation prompt', () => {
    expect(managementClient).toContain('data-manage-action="run"')
    expect(managementClient).toContain("postAction('/flow/run', { inspectionId: id })")
    expect(managementClient).not.toContain("type: 'dsh-patrol:run-flow'")
    expect(managementClient).not.toContain('window.parent.postMessage')
  })

  it('executes replay inside runMaintenance and starts Recovery only after a real browser failure', () => {
    expect(managementHost).toContain("path: `${prefix}/flow/run`")
    expect(managementHost).toContain("const replayTool = pending === undefined ? 'patrol_run_flow' : 'patrol_resume_flow'")
    expect(managementHost).toContain('runMaintenance(async signal =>')
    expect(managementHost).toContain("name: replayTool")
    expect(managementHost).toContain("internalPatrolWorkerPath(String(workerRoot || ''), 'recovery')")
    expect(managementHost).toContain("mountInternalPatrolWorker(ctx, agentCtx, compositionPath, 'recovery')")
    expect(managementHost).not.toContain("const RECOVERY_PRESET = 'patrol-recovery'")
    expect(managementHost).not.toContain("ctx.get('agentPresets')")
    expect(managementHost).toContain("item.tool.startsWith('browser_')")
    expect(managementHost).toContain('zeroModelReplay: true')
    expect(managementHost).not.toContain('.session.prompt(')
  })
})
