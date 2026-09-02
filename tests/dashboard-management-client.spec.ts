import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(process.cwd(), 'browser-bridge-runtime', 'dashboard-management-client.js'), 'utf8')

describe('dashboard flow-management client', () => {
  it('keeps MutationObserver patches idempotent and yields to the event loop', () => {
    expect(source).toContain('if (time.textContent !== nextText) time.textContent = nextText')
    expect(source).toContain('setTimeout(() => {')
    expect(source).not.toContain('queueMicrotask(() => {')
  })

  it('explains that flow cleanup removes teaching probes rather than real operations', () => {
    expect(source).toContain('这是“清理教学试错步骤”，不是删除流程。')
    expect(source).toContain('会保留：导航、点击、输入、人工检查点、条件依赖、断言，以及最终截图/页面产物。')
  })
})
