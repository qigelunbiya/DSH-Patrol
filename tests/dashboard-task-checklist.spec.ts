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

  it('uses human Chinese labels for flow lifecycle state', () => {
    expect(source).toContain("ready: '已保存'")
    expect(source).toContain("draft: '编辑中'")
    expect(source).toContain('<span>已保存</span>')
    expect(source).not.toContain("ready: '已就绪'")
    expect(source).not.toContain("draft: '草稿'")
  })
})
