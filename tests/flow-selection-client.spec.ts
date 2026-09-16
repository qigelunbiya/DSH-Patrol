import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const clientSource = readFileSync(join(process.cwd(), 'client-host-runtime', 'client.js'), 'utf8')

describe('Patrol flow selection client surface', () => {
  it('renames direct-run controls to selection controls', () => {
    expect(clientSource).toContain("}, '选择流程');")
    expect(clientSource).toContain("run.textContent = '选择流程'")
    expect(clientSource).not.toContain("run.textContent = '▶ 运行流程'")
  })

  it('selects a flow without executing it immediately', () => {
    expect(clientSource).toContain('function createFlowChooser(workspaceRoot, runFlow)')
    expect(clientSource).toContain("button.addEventListener('click', () => selectFlow(flow));")
    expect(clientSource).not.toContain('选择一个流程即可直接开始运行，无需先发送消息。')
    expect(clientSource).toContain('点击流程不会立即执行。')
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

  it('requires the explicit execute button after a selection', () => {
    expect(clientSource).toContain('data-dsh-patrol-flow-execute')
    expect(clientSource).toContain("execute?.addEventListener('click', async () =>")
    expect(clientSource).toContain('if (!selectedFlow || busy) return;')
    expect(clientSource).toContain('await runFlow(selectedFlow.id, selectedFlow.name);')
    expect(clientSource).toContain('只有点击“执行选中流程”才会开始运行。')
  })
})
