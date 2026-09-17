import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(process.cwd(), 'browser-bridge-runtime', 'dashboard-client.js'), 'utf8')

describe('flow detail task checklist', () => {
  it('shows the persisted checklist on flow details', () => {
    expect(source).toContain('<h3 class="section-title">任务清单</h3>${taskChecklistView(definition)}')
    expect(source).toContain('function taskChecklistView(definition)')
    expect(source).toContain('definition?.metadata?.taskChecklist')
  })
})
