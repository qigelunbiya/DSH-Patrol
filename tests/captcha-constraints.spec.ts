import { describe, expect, it } from 'vitest'
import { imageCodeConstraintError, inferImageCodeConstraint, renderImageCodeConstraint } from '../src/captcha-constraints.ts'

describe('image-code task constraints', () => {
  it('treats four English letters with no digits as a hard format', () => {
    const constraint = inferImageCodeConstraint(['识别并填写四位英文验证码，没有数字'])
    expect(constraint).toMatchObject({ length: 4, lettersOnly: true })
    expect(imageCodeConstraintError('QTMZ', constraint)).toBeUndefined()
    expect(imageCodeConstraintError('VC4A', constraint)).toMatch(/no digits/i)
    expect(imageCodeConstraintError('ABC', constraint)).toMatch(/exactly 4/i)
    expect(renderImageCodeConstraint(constraint)).toContain('length=4')
    expect(renderImageCodeConstraint(constraint)).toContain('letters-only/no-digits')
  })

  it('does not invent a letters-only rule when the checklist allows alphanumerics', () => {
    const constraint = inferImageCodeConstraint(['填写6位字母数字验证码'])
    expect(constraint).toMatchObject({ length: 6, lettersOnly: false })
    expect(imageCodeConstraintError('AB12CD', constraint)).toBeUndefined()
  })
})
