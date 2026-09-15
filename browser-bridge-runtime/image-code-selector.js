const TOP_FRAME_SELECTOR_PREFIX = /^top-frame::([\s\S]+)$/

export function canonicalImageCodeSelector(selector) {
  const value = typeof selector === 'string' ? selector.trim() : ''
  if (!value) return ''
  const top = TOP_FRAME_SELECTOR_PREFIX.exec(value)
  return top ? top[1] : value
}

export function imageCodeCaptureSelector(selector) {
  return canonicalImageCodeSelector(selector)
}

export function imageCodeSelectorsEquivalent(left, right) {
  const a = canonicalImageCodeSelector(left)
  const b = canonicalImageCodeSelector(right)
  return Boolean(a && b && a === b)
}
