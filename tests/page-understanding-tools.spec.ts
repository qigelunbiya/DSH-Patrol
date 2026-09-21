import { describe, expect, it } from 'vitest'
import { analyzePageEvidence, createPatrolPlanningGuard, createPatrolTestModePlanningGuard, PATROL_PAGE_UNDERSTANDING_PROMPT } from '../src/page-understanding-tools.js'
import { createPatrolClickOutcomeTracker } from '../src/click-retry-state.js'

describe('Patrol page understanding planner', () => {
  it('lets TEST MODE choose vision directly without DOM/analyze authorization', () => {
    const guard = createPatrolTestModePlanningGuard(createPatrolClickOutcomeTracker())
    expect(guard({
      name: 'patrol_observe',
      arguments: { inspectionId: 'test-live', includeImage: true },
    })).toBeUndefined()
    expect(guard({
      name: 'patrol_visual_click_target',
      arguments: {
        inspectionId: 'test-live',
        stepName: '点击目标视频',
        targetHint: 'AI圈核弹雨视频',
        frameId: 'browser-visual-current',
        xRatio: 0.37,
        yRatio: 0.5,
      },
    })).toBeUndefined()
  })

  it('lets NORMAL MODE choose vision directly without a DOM-first sequence', () => {
    const guard = createPatrolPlanningGuard(createPatrolClickOutcomeTracker())
    expect(guard({
      name: 'patrol_observe',
      arguments: { inspectionId: 'normal-live', includeImage: true },
    })).toBeUndefined()
    expect(guard({
      name: 'patrol_visual_click_target',
      arguments: {
        inspectionId: 'normal-live',
        stepName: '点击评论输入框',
        targetHint: '评论输入框',
        frameId: 'browser-visual-current',
        xRatio: 0.3,
        yRatio: 0.9,
      },
    })).toBeUndefined()
  })

  it('allows arbitrarily many fresh visual observations while keeping strategy neutral', () => {
    for (const makeGuard of [
      () => createPatrolTestModePlanningGuard(createPatrolClickOutcomeTracker()),
      () => createPatrolPlanningGuard(createPatrolClickOutcomeTracker()),
    ]) {
      const guard = makeGuard()
      for (let index = 0; index < 8; index += 1) {
        expect(guard({
          name: 'patrol_observe',
          arguments: { inspectionId: 'image-budget', includeImage: true },
        })).toBeUndefined()
      }
    }
    expect(PATROL_PAGE_UNDERSTANDING_PROMPT).toMatch(/视觉截图不设固定次数上限/)
    expect(PATROL_PAGE_UNDERSTANDING_PROMPT).toMatch(/image\/offload.*旧工具图片移出模型可见输入/s)
    expect(PATROL_PAGE_UNDERSTANDING_PROMPT).not.toMatch(/最多向模型附加两张|两张视觉截图/)
    expect(PATROL_PAGE_UNDERSTANDING_PROMPT).not.toMatch(/DOM 永远优先|视觉像素只允许作为最后兜底/)
    expect(PATROL_PAGE_UNDERSTANDING_PROMPT).toMatch(/用户最近一条明确指令/)
    expect(PATROL_PAGE_UNDERSTANDING_PROMPT).toMatch(/用户未指定方法时.*不规定固定优先级/)
    expect(PATROL_PAGE_UNDERSTANDING_PROMPT).toMatch(/只用视觉.*visualAuthority=true/)
    expect(PATROL_PAGE_UNDERSTANDING_PROMPT).toMatch(/明确禁止视觉.*不得 includeImage=true/)
    expect(PATROL_PAGE_UNDERSTANDING_PROMPT).not.toMatch(/TEST MODE 是 UI-TARS 风格 visual-grounding/)
  })

  it('does not hard-stop method switching after unverified physical clicks', () => {
    const outcomes = createPatrolClickOutcomeTracker()
    const guard = createPatrolPlanningGuard(outcomes)
    const visualArgs = {
      inspectionId: 'bili',
      stepName: '点击目标视频',
      targetHint: 'AI圈核弹雨视频',
      frameId: 'browser-visual-current',
      xRatio: 0.37,
      yRatio: 0.5,
    }
    outcomes.recordVisualPhysicalClick(visualArgs)
    outcomes.recordUnverifiedPhysicalClick(visualArgs)
    outcomes.recordVisualPhysicalClick(visualArgs)
    outcomes.recordUnverifiedPhysicalClick(visualArgs)

    expect(guard({ name: 'patrol_visual_click_target', arguments: visualArgs })).toBeUndefined()
    expect(guard({
      name: 'patrol_click_target',
      arguments: { inspectionId: 'bili', stepName: '点击目标视频', locatorText: 'AI圈核弹雨' },
    })).toBeUndefined()
  })

  it('does not hard-stop a verified navigation click when the model needs to choose another video', () => {
    const outcomes = createPatrolClickOutcomeTracker()
    const guard = createPatrolPlanningGuard(outcomes)
    const args = {
      inspectionId: 'bili',
      stepName: '点击目标视频',
      targetHint: '首页视频卡片',
      frameId: 'browser-visual-current',
      xRatio: 0.4,
      yRatio: 0.5,
    }
    outcomes.recordVisualPhysicalClick(args)
    outcomes.recordVerified(args)
    expect(guard({ name: 'patrol_visual_click_target', arguments: args })).toBeUndefined()
    expect(guard({
      name: 'patrol_click_target',
      arguments: { inspectionId: 'bili', stepName: '点击目标视频', locatorText: '另一个视频' },
    })).toBeUndefined()
  })

  it('still protects an already verified visual toggle from an accidental repeat click', () => {
    const outcomes = createPatrolClickOutcomeTracker()
    const guard = createPatrolPlanningGuard(outcomes)
    const args = {
      inspectionId: 'bili',
      stepName: '给视频点赞',
      targetHint: '点赞按钮',
      frameId: 'browser-visual-current',
      xRatio: 0.1,
      yRatio: 0.8,
    }
    outcomes.recordVisualPhysicalClick(args)
    outcomes.recordVerified(args)
    expect(guard({ name: 'patrol_visual_click_target', arguments: args })).toMatch(/已验证的视觉物理点击|HARD STOP/)
  })

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

  it('collapses duplicate CURRENT wrappers when an exact title-backed leaf exists', () => {
    const plans = analyzePageEvidence('点击主机下的未分组', '未分组', '', [
      { tag: 'span', role: '', text: '未分组', selector: 'top-frame::.new_tree_box span[title="未分组"]' },
      { tag: 'span', role: '', text: '未分组', selector: 'top-frame::div:nth-of-type(2) > span:nth-of-type(2)' },
      { tag: 'div', role: '', text: '未分组', selector: 'top-frame::.ant-tree-node-content-wrapper' },
    ])
    expect(plans[0]).toMatchObject({
      kind: 'semantic',
      selector: 'top-frame::.new_tree_box span[title="未分组"]',
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

  it('rejects unsupported selector dialects but keeps a valid locatorText path usable', () => {
    const guard = createPatrolPlanningGuard()
    expect(guard({
      name: 'patrol_click',
      arguments: { inspectionId: 'demo', stepName: 'bad selector', selector: 'span:has-text("点赞")' },
    })).toMatch(/只接受 CSS/)
    expect(guard({
      name: 'patrol_click_target',
      arguments: {
        inspectionId: 'demo',
        stepName: '点击主机 - 未分组',
        locatorText: '未分组',
        selector: 'top-frame::span:has-text("未分组")',
      },
    })).toBeUndefined()
    expect(PATROL_PAGE_UNDERSTANDING_PROMPT).toMatch(/丢弃这个可选 hint/)
  })

  it('also blocks raw browser selector dialects before dispatch', () => {
    const guard = createPatrolPlanningGuard()
    expect(guard({ name: 'browser_click', arguments: { selector: '//span[text()="未分组"]' } })).toMatch(/只接受 CSS/)
    expect(guard({ name: 'browser_read_page', arguments: { selector: 'div:has-text(未分组)' } })).toMatch(/只接受 CSS/)
  })

  it('keeps image-code on its dedicated OCR/token-gated path in TEST MODE', () => {
    expect(PATROL_PAGE_UNDERSTANDING_PROMPT).toMatch(/图片字符验证码不走通用页面点击规划器/)
    expect(PATROL_PAGE_UNDERSTANDING_PROMPT).toMatch(/patrol_solve_current_image_code/)
    expect(PATROL_PAGE_UNDERSTANDING_PROMPT).toMatch(/Windows OCR\/本地 OCR/)
    expect(PATROL_PAGE_UNDERSTANDING_PROMPT).toMatch(/一次性 fallbackToken/)
    expect(PATROL_PAGE_UNDERSTANDING_PROMPT).toMatch(/没有 fallbackToken 时禁止模型视觉验证码/)
    expect(PATROL_PAGE_UNDERSTANDING_PROMPT).toMatch(/patrol_visual_click_target/)
    expect(PATROL_PAGE_UNDERSTANDING_PROMPT).toMatch(/visualFrameId/)
    expect(PATROL_PAGE_UNDERSTANDING_PROMPT).toMatch(/browser_visual_click/)
  })
})
