import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { deriveSemanticTargetContext } from '../src/click-target-tools.ts'
import type { InspectionDefinition } from '../src/types.ts'

function definition(checklist: string[]): Pick<InspectionDefinition, 'metadata'> {
  return {
    metadata: {
      createdAt: '2026-09-15T00:00:00.000Z',
      updatedAt: '2026-09-15T00:00:00.000Z',
      taskChecklist: checklist,
    },
  }
}

describe('semantic click target context', () => {
  it('recovers a unique row identity from the persisted checklist when stepName keeps only the action', () => {
    const target = deriveSemanticTargetContext(
      definition([
        '进入主机运维',
        '点击 10.192.3.174 这台运维机的 RDP',
        '填写运维登录信息',
        '截图',
      ]),
      '点击RDP',
      '[RDP] [EMPTY]',
    )

    expect(target).toBe('点击 10.192.3.174 这台运维机的 RDP')
  })

  it('uses a stable identity token from stepName when several checklist items share the same action', () => {
    const target = deriveSemanticTargetContext(
      definition([
        '点击 10.192.3.249 的 RDP',
        '点击 10.192.3.174 的 RDP',
      ]),
      '点击 10.192.3.174 的 RDP',
      'RDP',
    )

    expect(target).toBe('点击 10.192.3.174 的 RDP')
  })

  it('stays fail-closed when multiple checklist rows have the same action and no identity is supplied', () => {
    const target = deriveSemanticTargetContext(
      definition([
        '点击 10.192.3.249 的 RDP',
        '点击 10.192.3.174 的 RDP',
      ]),
      '点击RDP',
      'RDP',
    )

    expect(target).toBeUndefined()
  })

  it('plumbs the checklist context through the semantic browser primitive without changing click mechanics', () => {
    const root = process.cwd()
    const clickTarget = readFileSync(join(root, 'src', 'click-target-tools.ts'), 'utf8')
    const semantic = readFileSync(join(root, 'browser-bridge-runtime', 'semantic-click-tool.js'), 'utf8')
    const extension = readFileSync(join(root, 'browser-extension', 'generic-title-row-action-hardening.js'), 'utf8')

    expect(clickTarget).toContain('targetContext,')
    expect(semantic).toContain('targetContext: optStr')
    expect(semantic).toContain('targetContext: args.targetContext')
    expect(extension).toContain('args?.targetContext')
    expect(extension).toContain("args: ['click', chosen.spec]")
    expect(extension).not.toContain('puppeteer-trusted-click')
  })
})
