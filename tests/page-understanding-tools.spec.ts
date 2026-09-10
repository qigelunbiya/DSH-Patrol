import { describe, expect, it } from 'vitest'
import { analyzePageEvidence, createPatrolPlanningGuard, PATROL_PAGE_UNDERSTANDING_PROMPT } from '../src/page-understanding-tools.js'

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
    expect(plans[0]).toMatchObject({
      kind: 'semantic',
      selector: 'top-frame::#workbench',
      locatorText: '我的工作台',
    })
  })

  it('refuses to pretend an ambiguous same-text target is unique', () => {
    const plans = analyzePageEvidence('点击 RDP', 'RDP', '', [
      { tag: 'span', role: 'button', text: 'RDP', selector: '#a' },
      { tag: 'span', role: 'button', text: 'RDP', selector: '#b' },
    ])
    expect(plans[0]?.kind).toBe('no-unique-target')
  })

  it('forces analysis before a raw CSS click and before a second semantic retry', () => {
    const guard = createPatrolPlanningGuard()
    const semantic = () => guard({
      name: 'patrol_click_target',
      arguments: { inspectionId: 'demo', stepName: '点击我的工作台', locatorText: '我的工作台' },
    })

    expect(semantic()).toBeUndefined()
    expect(semantic()).toMatch(/patrol_analyze_step/)
    expect(guard({
      name: 'patrol_analyze_step',
      arguments: { inspectionId: 'demo', task: '点击我的工作台' },
    })).toBeUndefined()
    expect(semantic()).toBeUndefined()
    expect(semantic()).toMatch(/已经尝试两个方案/)

    const fresh = createPatrolPlanningGuard()
    expect(fresh({
      name: 'patrol_click',
      arguments: { inspectionId: 'demo', stepName: '点击 RDP', selector: 'tr:nth-of-type(3) span.action' },
    })).toMatch(/patrol_analyze_step/)
  })

  it('resets a stalled click phase after meaningful non-click progress', () => {
    const guard = createPatrolPlanningGuard()
    expect(guard({ name: 'patrol_click_target', arguments: { inspectionId: 'demo', stepName: '点击确定', locatorText: '确定' } })).toBeUndefined()
    expect(guard({ name: 'patrol_type_text', arguments: { inspectionId: 'demo', stepName: '输入下一字段', selector: '#name', text: 'x' } })).toBeUndefined()
    expect(guard({ name: 'patrol_click_target', arguments: { inspectionId: 'demo', stepName: '点击确定', locatorText: '确定' } })).toBeUndefined()
  })

  it('keeps the existing image-code OCR path explicitly out of the planner', () => {
    expect(PATROL_PAGE_UNDERSTANDING_PROMPT).toMatch(/不能替换图片字符验证码链路/)
    expect(PATROL_PAGE_UNDERSTANDING_PROMPT).toMatch(/patrol_solve_current_image_code/)
    expect(PATROL_PAGE_UNDERSTANDING_PROMPT).toMatch(/ddddocr \+ Windows OCR/)
    expect(PATROL_PAGE_UNDERSTANDING_PROMPT).toMatch(/不要为每个内部工具调用.*重复/s)
  })
})
