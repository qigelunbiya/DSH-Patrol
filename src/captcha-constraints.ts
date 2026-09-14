const IMAGE_CODE_TASK_HINT = /(验证码|校验码|图形码|captcha|image[-_ ]?code)/i
const LETTER_ONLY_HINT = /(?:没有|无|不含|不包含|不能有|不要|禁止).*?(?:数字|digit|number)|(?:纯|全是|仅|只(?:有|含)?).*?(?:英文|英文字母|字母|letter)/i

export interface ImageCodeConstraint {
  length?: number
  lettersOnly: boolean
  source?: string
}

export function inferImageCodeConstraint(taskChecklist: readonly string[]): ImageCodeConstraint {
  const relevant = taskChecklist.filter(item => IMAGE_CODE_TASK_HINT.test(item))
  if (relevant.length === 0) return { lettersOnly: false }
  const source = relevant.join('；')
  const length = expectedImageCodeLength(source)
  return {
    ...(length === undefined ? {} : { length }),
    lettersOnly: LETTER_ONLY_HINT.test(source),
    source,
  }
}

export function imageCodeConstraintError(code: string, constraint: ImageCodeConstraint): string | undefined {
  if (constraint.length !== undefined && code.length !== constraint.length) {
    return `expected exactly ${constraint.length} character(s), got ${code.length}`
  }
  if (constraint.lettersOnly && !/^[A-Za-z]+$/.test(code)) {
    return 'expected ASCII letters only with no digits'
  }
  return undefined
}

export function renderImageCodeConstraint(constraint: ImageCodeConstraint): string {
  const parts: string[] = []
  if (constraint.length !== undefined) parts.push(`length=${constraint.length}`)
  if (constraint.lettersOnly) parts.push('letters-only/no-digits')
  if (parts.length === 0) return ''
  return `Persisted image-code format constraint: ${parts.join(', ')}.`
}

function expectedImageCodeLength(source: string): number | undefined {
  const arabic = /(?:^|[^0-9])(\d{1,2})\s*(?:位|个)(?:数|字符|字母|英文|英文字母|码)?/i.exec(source)
  if (arabic?.[1] !== undefined) {
    const value = Number.parseInt(arabic[1], 10)
    if (value >= 2 && value <= 16) return value
  }
  const chinese = /([一二三四五六七八九十])\s*(?:位|个)/.exec(source)?.[1]
  if (chinese !== undefined) {
    const value = ({ 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 } as Record<string, number>)[chinese] ?? 0
    if (value >= 2 && value <= 16) return value
  }
  return undefined
}
