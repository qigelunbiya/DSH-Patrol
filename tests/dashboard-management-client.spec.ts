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

  it('explains stronger teaching cleanup and semantic finalization', () => {
    expect(source).toContain('猜 URL/试错轮次')
    expect(source).toContain('patrol_finalize_flow')
    expect(source).toContain('真正成功路径')
  })

  it('can inspect and copy the exact stored flow JSON', () => {
    expect(source).toContain('查看流程 JSON')
    expect(source).toContain('JSON.stringify(item.definition, null, 2)')
    expect(source).toContain('复制 JSON')
    expect(source).toContain('patrol-flow-json-code')
  })

  it('shows exact per-step command arguments below the visual flow node', () => {
    expect(source).toContain('实际命令')
    expect(source).toContain('arguments: step.arguments || {}')
    expect(source).toContain('data-step-execution')
  })

  it('makes dashboard deletion an explicit physical history cleanup', () => {
    expect(source).toContain('这是物理删除，不是从界面隐藏')
    expect(source).toContain('deleteHistory: true')
    expect(source).toContain('patrol-results/<flow-id>/ 整个目录')
  })

  it('shows that rename writes a human-readable workspace flow file', () => {
    expect(source).toContain('.flow.md')
    expect(source).toContain('workspaceFlowFile')
  })
})
