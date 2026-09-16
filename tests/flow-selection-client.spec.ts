import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const clientSource = readFileSync(join(process.cwd(), 'client-host-runtime', 'client.js'), 'utf8')

describe('Patrol flow selection client surface', () => {
  it('keeps the flow launcher as a selection control', () => {
    expect(clientSource).toContain("}, '选择流程');")
    expect(clientSource).toContain("run.textContent = '选择流程'")
    expect(clientSource).not.toContain("run.textContent = '▶ 运行流程'")
  })

  it('separates previewing a flow from selecting it for execution', () => {
    expect(clientSource).toContain('function createFlowChooser(workspaceRoot, runFlows)')
    expect(clientSource).toContain("checkbox.setAttribute('data-dsh-patrol-flow-select', flow.id)")
    expect(clientSource).toContain("button.addEventListener('click', () => preview(flow));")
    expect(clientSource).toContain("checkbox.addEventListener('change', () => toggleSelected(flow));")
    expect(clientSource).toContain('点击流程名称只查看详情，不会自动勾选或执行。')
  })

  it('keeps selected flows in explicit serial execution order', () => {
    expect(clientSource).toContain('data-dsh-patrol-selected-order')
    expect(clientSource).toContain('const moveSelected = (flowId, delta) =>')
    expect(clientSource).toContain("up.textContent = '↑'")
    expect(clientSource).toContain("down.textContent = '↓'")
    expect(clientSource).toContain('selectedFlows = copy;')
  })

  it('shows selected-flow details and an ordered flow graph before execution', () => {
    expect(clientSource).toContain('data-dsh-patrol-flow-details')
    expect(clientSource).toContain('data-dsh-patrol-flow-graph')
    expect(clientSource).toContain('data-dsh-patrol-flow-step')
    expect(clientSource).toContain("graphTitle.textContent = '流程图'")
    expect(clientSource).toContain("checklistTitle.textContent = '任务清单'")
    expect(clientSource).toContain("addInfo(infoGrid, '目标地址'")
    expect(clientSource).toContain("addInfo(infoGrid, '预期结果'")
  })

  it('requires a final confirmation before starting multiple selected flows', () => {
    expect(clientSource).toContain('data-dsh-patrol-batch-confirm-list')
    expect(clientSource).toContain("execute.textContent = selectedFlows.length > 1 ? '下一步：确认批量巡检' : '执行选中流程'")
    expect(clientSource).toContain('if (selectedFlows.length > 1 && !confirming) { showConfirmationStage(); return; }')
    expect(clientSource).toContain("execute.textContent = '开始串行巡检'")
    expect(clientSource).toContain('固定串行执行（concurrency=1）')
  })

  it('preserves the existing single-flow replay path while batching only multi-selection', () => {
    expect(clientSource).toContain('async function sendFlowSelectionReplay(ctx, sessionId, flows)')
    expect(clientSource).toContain('if (items.length === 1) {')
    expect(clientSource).toContain('await sendFlowReplay(ctx, sessionId, items[0].id, items[0].name);')
    expect(clientSource).toContain('await conversation.send(batchReplayPrompt(items));')
    expect(clientSource).toContain('请一次调用 patrol_run_batch')
  })
})