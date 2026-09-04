import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const management = readFileSync(join(process.cwd(), 'browser-bridge-runtime', 'dashboard-management-client.js'), 'utf8')
const host = readFileSync(join(process.cwd(), 'client-host-runtime', 'client.js'), 'utf8')

describe('flow run button', () => {
  it('posts the stable flow id to the parent conversation host', () => {
    expect(management).toContain('data-manage-action="run"')
    expect(management).toContain("type: 'dsh-patrol:run-flow'")
    expect(management).toContain('inspectionId: id')
    expect(management).toContain('window.parent.postMessage')
  })

  it('validates same-origin iframe messages and runs the replay in a fresh Patrol session', () => {
    expect(host).toContain("data.type !== 'dsh-patrol:run-flow'")
    expect(host).toContain('event.origin !== window.location.origin')
    expect(host).toContain('event.source !== iframeRef.current?.contentWindow')
    expect(host).toContain('ctx.sessions.create')
    expect(host).toContain('ctx.remote.agentPresets.select')
    expect(host).toContain('ctx.sessions.binding')
    expect(host).toContain("binding.session.prompt([{ type: 'text', text: prompt }], 'queue')")
    expect(host).toContain('ctx.sessions.open(sessionId)')
    expect(host).toContain('仅调用一次 patrol_run_flow')
    expect(host).toContain('不要调用 patrol_last_failure、patrol_begin_edit、patrol_observe')
    expect(host).not.toContain('inputActions.setDraft')
  })
})
