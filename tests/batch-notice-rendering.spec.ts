import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(process.cwd(), 'src', 'flow-reference-tools.ts'), 'utf8')

describe('Patrol replay notice rendering', () => {
  it('carries skipped steps and warnings into batch results', () => {
    expect(source).toContain(".filter(result => result.status === 'skipped')")
    expect(source).toContain('skippedSteps')
    expect(source).toContain('warnings: [...report.warnings]')
  })

  it('surfaces non-fatal diagnostics in single and batch tool output', () => {
    expect(source).toContain('skippedStep=')
    expect(source).toContain('warning=')
    expect(source).toContain('跳过步骤')
    expect(source).toContain('最终答复必须显式说明这些非致命问题')
  })
})