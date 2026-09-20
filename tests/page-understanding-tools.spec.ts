import { describe, expect, it } from 'vitest'
import { analyzePageEvidence, createPatrolPlanningGuard, PATROL_PAGE_UNDERSTANDING_PROMPT } from '../src/page-understanding-tools.js'
import { createPatrolClickOutcomeTracker } from '../src/click-retry-state.js'

describe('Patrol page understanding planner', () => {
  it('binds a row identity to the action selector instead of clicking an ambiguous RDP label', () => {
    const page = [
      '[Structured table 1; rows=2]',
      'Row 1: 名称="10.192.3.249" | 目标/地址="10.192.3.249" | 访问方式="[RDP] [EMPTY]" [click "tr:nth-of-type(2) td:nth-of-type(5) span.action"]',
      'Row 2: 名称="方泽铭运维机" | 目标/地址="10.192.3.174" | 访问方式="[RDP] [EMPTY]" [click "tr:nth-of-type(3) td:nth-of-type(5) span.action"]',
    ].join('\n')

    const plans = analyzePageEvidence('点击 10.192.3.174 这台运维机的 RDP', 'RDP', page, [
      { tag: 'span', role: 'button', text: '[RDP] [EMPTY]', selector: 'tr:nth-of-type(2) span.action' },
      { tag: 'span', role: 'button', text: '[RDP] [EMPTY]', selector: 'tr:nth-of-type(3) span.action' },
    ])

    expect(plans[0]).toMatchObject({
      kind: 'structured-row',
      selector: 'tr:nth-of-type(3) td:nth-of-type(5) span.action',
    })
    expect(plans[0]?.evidence).toContain('10.192.3.174')
  })

  it('returns a unique semantic plan for a simple current-page target', () => {
    const plans = analyzePageEvidence('点击我的工作台', '我的工作台', '', [
      { tag: 'a', role: 'link', text: '我的工作台', selector: 'top-frame::#workbench' },
      { tag: 'a', role: 'link', text: '其他菜单', selector: 'top-frame::#other' },
    ])
    expect(plans[0]).toMatchObject({ kind: 'semantic', selector: 'top-frame::#workbench', locatorText: '我的工作台' })
  })

  it('collapses duplicate CURRENT wrappers when an exact title-backed tree leaf exists', () => {
    const plans = analyzePageEvidence('点击主机下的未分组', '未分组', '', [
      { tag: 'span', role: '', text: '未分组', selector: 'top-frame::.new_tree_box span[title="未分组"]' },
      { tag: 'span', role: '', text: '未分组', selector: 'top-frame::div:nth-of-type(2) > span:nth-of-type(2)' },
      { tag: 'div', role: '', text: '未分组', selector: 'top-frame::.ant-tree-node-content-wrapper' },
      { tag: 'div', role: '', text: '主机 未分组', selector: 'top-frame::.ant-tree-list-holder-inner' },
    ])
    expect(plans[0]).toMatchObject({
      kind: 'semantic',
      selector: 'top-frame::.new_tree_box span[title="未分组"]',
      locatorText: '未分组',
    })
  })

  it('prefers a unique exact title-backed tree target over nested same-text wrappers', () => {
    const plans = analyzePageEvidence('点击主机下的未分组', '未分组', '', [
      { tag: 'span', role: '', text: '未分组', selector: 'top-frame::span[title="未分组"]' },
      { tag: 'span', role: '', text: '未分组', selector: 'top-frame::div:nth-of-type(2) > span:nth-of-type(2)' },
      { tag: 'div', role: '', text: '主机 未分组', selector: 'top-frame::.ant-tree-list-holder-inner' },
      { tag: 'span', role: '', text: '工单运维', selector: 'top-frame::span[title="工单运维"]' },
    ])
    expect(plans[0]).toMatchObject({
      kind: 'semantic',
      selector: 'top-frame::span[title="未分组"]',
      locatorText: '未分组',
    })
  })

  it('refuses to pretend an ambiguous same-text target is unique', () => {
    const plans = analyzePageEvidence('点击 RDP', 'RDP', '', [
      { tag: 'span', role: 'button', text: 'RDP', selector: '#a' },
      { tag: 'span', role: 'button', text: 'RDP', selector: '#b' },
    ])
    expect(plans[0]?.kind).toBe('no-unique-target')
  })

  it('allows a Bilibili-like visual fallback after one failed semantic attempt plus CURRENT analysis even when locator wording changes', () => {
    const guard = createPatrolPlanningGuard()

    expect(guard({
      name: 'patrol_click_target',
      arguments: { inspectionId: 'bili', stepName: '给视频点赞', locatorText: '点赞' },
    })).toBeUndefined()
    expect(guard({
      name: 'patrol_click_target',
      arguments: { inspectionId: 'bili', stepName: '给视频点赞', locatorText: '大拇指图标' },
    })).toMatch(/patrol_analyze_step/)
    expect(guard({
      name: 'patrol_analyze_step',
      arguments: { inspectionId: 'bili', task: '给视频点赞', locatorText: '大拇指图标' },
    })).toBeUndefined()
    expect(guard({
      name: 'patrol_visual_click_target',
      arguments: {
        inspectionId: 'bili',
        stepName: '给视频点赞',
        targetHint: '视频下方的大拇指点赞按钮',
        frameId: 'browser-visual-current',
        xRatio: 0.08,
        yRatio: 0.75,
      },
    })).toBeUndefined()
  })

  it('does not poison the business target when a visual fallback fails before any physical click', () => {
    const outcomes = createPatrolClickOutcomeTracker()
    const guard = createPatrolPlanningGuard(outcomes)
    const semantic = () => guard({
      name: 'patrol_click_target',
      arguments: { inspectionId: 'demo', stepName: '点击目标行的 RDP', locatorText: 'RDP' },
    })
    const visual = (frameId: string) => guard({
      name: 'patrol_visual_click_target',
      arguments: {
        inspectionId: 'demo',
        stepName: '点击目标行的 RDP',
        targetHint: 'CURRENT 截图中的 RDP 图标',
        frameId,
        xRatio: 0.82,
        yRatio: 0.61,
      },
    })

    expect(semantic()).toBeUndefined()
    expect(semantic()).toMatch(/patrol_analyze_step/)
    expect(guard({
      name: 'patrol_analyze_step',
      arguments: { inspectionId: 'demo', task: '点击目标行的 RDP', locatorText: 'RDP' },
    })).toBeUndefined()

    expect(visual('browser-visual-1')).toBeUndefined()
    expect(visual('browser-visual-2')).toBeUndefined()

    outcomes.recordVisualPhysicalClick({ inspectionId: 'demo', stepName: '点击目标行的 RDP' })
    outcomes.recordUnverifiedPhysicalClick({ inspectionId: 'demo', stepName: '点击目标行的 RDP' })
    expect(visual('browser-visual-3')).toBeUndefined()
    outcomes.recordVisualPhysicalClick({ inspectionId: 'demo', stepName: '点击目标行的 RDP' })
    outcomes.recordUnverifiedPhysicalClick({ inspectionId: 'demo', stepName: '点击目标行的 RDP' })
    expect(visual('browser-visual-4')).toMatch(/HARD STOP/)
  })

  it('does not reset a stalled selector budget just because the same target is renamed cosmetically', () => {
    const guard = createPatrolPlanningGuard()
    expect(guard({
      name: 'patrol_click_target',
      arguments: { inspectionId: 'demo', stepName: '点击主机下的未分组', locatorText: '未分组' },
    })).toBeUndefined()
    expect(guard({
      name: 'patrol_analyze_step',
      arguments: { inspectionId: 'demo', task: '点击未分组节点', locatorText: '未分组' },
    })).toBeUndefined()
    expect(guard({
      name: 'patrol_click',
      arguments: { inspectionId: 'demo', stepName: '点击未分组', selector: 'span[title="未分组"]' },
    })).toBeUndefined()
    expect(guard({
      name: 'patrol_click',
      arguments: { inspectionId: 'demo', stepName: '尝试未分组菜单项', selector: '.ant-tree-node-content-wrapper' },
    })).toMatch(/DOM selector 策略已耗尽|patrol_visual_click_target/)
  })

  it('rejects unsupported selector dialects without consuming the final recovery budget', () => {
    const guard = createPatrolPlanningGuard()
    expect(guard({
      name: 'patrol_click_target',
      arguments: { inspectionId: 'demo', stepName: '点击主机下的未分组', locatorText: '未分组' },
    })).toBeUndefined()
    expect(guard({
      name: 'patrol_analyze_step',
      arguments: { inspectionId: 'demo', task: '点击主机下的未分组', locatorText: '未分组' },
    })).toBeUndefined()
    expect(guard({
      name: 'patrol_click',
      arguments: { inspectionId: 'demo', stepName: '点击未分组', selector: 'span:contains("未分组")' },
    })).toMatch(/只接受 CSS|不计入.*策略预算/)
    expect(guard({
      name: 'patrol_click',
      arguments: { inspectionId: 'demo', stepName: '点击未分组', selector: 'span[title="未分组"]' },
    })).toBeUndefined()
    expect(guard({
      name: 'patrol_click',
      arguments: { inspectionId: 'demo', stepName: '点击未分组', selector: '.ant-tree-node-content-wrapper' },
    })).toMatch(/DOM selector 策略已耗尽|patrol_visual_click_target/)
  })

  it('does not let an invalid optional selector hint block patrol_click_target when locatorText is valid', () => {
    const guard = createPatrolPlanningGuard()
    expect(guard({
      name: 'patrol_click_target',
      arguments: {
        inspectionId: 'demo',
        stepName: '点击主机 - 未分组',
        locatorText: '未分组',
        selector: 'top-frame::span:has-text("未分组")',
      },
    })).toBeUndefined()
    expect(PATROL_PAGE_UNDERSTANDING_PROMPT).toMatch(/优先只传 locatorText 给 patrol_click_target/)
    expect(PATROL_PAGE_UNDERSTANDING_PROMPT).toMatch(/丢弃这个可选 hint/)
  })

  it('also blocks raw browser selector dialects before dispatch', () => {
    const guard = createPatrolPlanningGuard()
    expect(guard({
      name: 'browser_click',
      arguments: { selector: '//span[text()="未分组"]' },
    })).toMatch(/只接受 CSS/)
    expect(guard({
      name: 'browser_read_page',
      arguments: { selector: 'div:has-text(未分组)' },
    })).toMatch(/只接受 CSS/)
  })

  it('counts a raw selector recovery as the second and final strategy', () => {
    const guard = createPatrolPlanningGuard()
    expect(guard({
      name: 'patrol_click_target',
      arguments: { inspectionId: 'demo', stepName: '点击目标行的 RDP', locatorText: 'RDP' },
    })).toBeUndefined()
    expect(guard({
      name: 'patrol_analyze_step',
      arguments: { inspectionId: 'demo', task: '点击目标行的 RDP', locatorText: 'RDP' },
    })).toBeUndefined()
    expect(guard({
      name: 'patrol_click',
      arguments: { inspectionId: 'demo', stepName: '点击目标行的 RDP', selector: 'tr:nth-of-type(2) span.action' },
    })).toBeUndefined()
    expect(guard({
      name: 'patrol_click_target',
      arguments: { inspectionId: 'demo', stepName: '点击目标行的 RDP', locatorText: 'RDP' },
    })).toMatch(/DOM selector 策略已耗尽|patrol_visual_click_target/)
  })

  it('resets a stalled click phase after meaningful non-click progress', () => {
    const guard = createPatrolPlanningGuard()
    const click = { name: 'patrol_click_target', arguments: { inspectionId: 'demo', stepName: '点击确定', locatorText: '确定' } }
    expect(guard(click)).toBeUndefined()
    expect(guard(click)).toMatch(/patrol_analyze_step/)
    expect(guard({ name: 'patrol_type_text', arguments: { inspectionId: 'demo', stepName: '输入下一字段', selector: '#name', text: 'x' } })).toBeUndefined()
    expect(guard(click)).toBeUndefined()
  })

  it('still gives physical-click safety priority and permits only one analyzed recovery retry', () => {
    const outcomes = createPatrolClickOutcomeTracker()
    const guard = createPatrolPlanningGuard(outcomes)
    const click = { name: 'patrol_click_target', arguments: {
      inspectionId: 'demo', stepName: '点击提交', locatorText: '提交',
    } }

    expect(guard(click)).toBeUndefined()
    outcomes.recordUnverifiedPhysicalClick(click.arguments)
    expect(guard(click)).toMatch(/patrol_analyze_step/)
    expect(guard({ name: 'patrol_analyze_step', arguments: { inspectionId: 'demo', task: '点击提交' } })).toBeUndefined()
    expect(guard(click)).toBeUndefined()
    outcomes.recordUnverifiedPhysicalClick(click.arguments)
    expect(guard(click)).toMatch(/HARD STOP/)

    outcomes.recordVerified(click.arguments)
    expect(guard({ name: 'patrol_type_text', arguments: { inspectionId: 'demo', stepName: '进入下一阶段', selector: '#x', text: 'x' } })).toBeUndefined()
    expect(guard(click)).toBeUndefined()
  })

  it('clears stale click outcomes when an existing flow is reopened for editing', () => {
    const outcomes = createPatrolClickOutcomeTracker()
    const guard = createPatrolPlanningGuard(outcomes)
    const click = { name: 'patrol_click_target', arguments: {
      inspectionId: 'legacy-flow', stepName: '点击 Logo', locatorText: '长城网际',
    } }

    outcomes.recordUnverifiedPhysicalClick(click.arguments)
    outcomes.recordUnverifiedPhysicalClick(click.arguments)
    expect(guard(click)).toMatch(/HARD STOP/)
    expect(guard({ name: 'patrol_begin_edit', arguments: { inspectionId: 'legacy-flow' } })).toBeUndefined()
    expect(guard(click)).toBeUndefined()
  })

  it('keeps image-code out of the click planner and makes TEST teaching local-OCR-first', () => {
    expect(PATROL_PAGE_UNDERSTANDING_PROMPT).toMatch(/图片字符验证码不走页面点击规划器/)
    expect(PATROL_PAGE_UNDERSTANDING_PROMPT).toMatch(/patrol_solve_current_image_code/)
    expect(PATROL_PAGE_UNDERSTANDING_PROMPT).toMatch(/Windows OCR\/本地 OCR/)
    expect(PATROL_PAGE_UNDERSTANDING_PROMPT).toMatch(/一次性 fallbackToken/)
    expect(PATROL_PAGE_UNDERSTANDING_PROMPT).toMatch(/没有 fallbackToken 时禁止模型视觉/)
    expect(PATROL_PAGE_UNDERSTANDING_PROMPT).not.toMatch(/不要先跑 ddddocr\/Windows OCR 预检/)
    expect(PATROL_PAGE_UNDERSTANDING_PROMPT).toMatch(/HARD STOP/)
    expect(PATROL_PAGE_UNDERSTANDING_PROMPT).toMatch(/最终 HARD STOP.*必须直接结束当前 assistant turn/)
    expect(PATROL_PAGE_UNDERSTANDING_PROMPT).toMatch(/patrol_visual_click_target/)
    expect(PATROL_PAGE_UNDERSTANDING_PROMPT).toMatch(/visualFrameId/)
    expect(PATROL_PAGE_UNDERSTANDING_PROMPT).toMatch(/browser_visual_click/)
    expect(PATROL_PAGE_UNDERSTANDING_PROMPT).toMatch(/不要为每个内部工具调用.*重复/s)
  })
})
