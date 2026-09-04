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

  it('validates same-origin iframe messages and submits a non-mutating replay request', () => {
    expect(host).toContain("data.type !== 'dsh-patrol:run-flow'")
    expect(host).toContain('event.origin !== window.location.origin')
    expect(host).toContain('event.source !== iframeRef.current?.contentWindow')
    expect(host).toContain('inputActions.setDraft')
    expect(host).toContain('inputActions.submit()')
    expect(host).toContain('不要修改、重教或新增流程步骤')
  })
})
