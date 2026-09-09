// Minimal all-frame DOM bridge used by DSH Patrol for iframe-heavy legacy
// portals. It intentionally exposes only the same safe DOM operations already
// available in the top-frame content bridge, plus structured table extraction.

const FRAME_SENSITIVE_INPUT = /(pass(word|wd)?|pwd|secret|token|api[-_]?key|authorization|cookie|session[-_]?id|otp|captcha|verification)/i
const FRAME_ACTION_TEXT_HINT = /(\[[^\]]{1,24}\]|\b(RDP|SSH|VNC|SFTP|FTP|HTTP|HTTPS)\b|登录|访问|打开|连接|进入|查看|详情|配置|下载|确定|提交|查询|导出)/i
const FRAME_BASE_INTERACTIVE_SELECTOR = 'a,button,input,select,textarea,[role="button"],[role="link"],[role="checkbox"],[role="tab"],[contenteditable="true"],[onclick]'
const FRAME_CUSTOM_INTERACTIVE_SELECTOR = '[tabindex],div,span,li,p,label,strong,img,svg'

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'dsh-patrol:frame-command') return
  Promise.resolve(handleFrameCommand(message.cmd, message.args || {}))
    .then(value => sendResponse(value))
    .catch(error => sendResponse({ ok: false, error: frameSafeError(error) }))
  return true
})

async function handleFrameCommand(cmd, args) {
  switch (cmd) {
    case 'snapshot': return frameSnapshot(args)
    case 'readPage': return frameReadPage(args)
    case 'count': return frameCount(args)
    case 'click': return frameClick(args)
    case 'type': return frameType(args)
    case 'press': return framePress(args)
    case 'scroll': return frameScroll(args)
    case 'wait': return await frameWait(args)
    default: throw new Error(`unsupported frame DOM command: ${cmd}`)
  }
}

function frameSnapshot(args) {
  const root = frameSelectRoot(args.selector)
  const max = Number.isInteger(args.maxElements) ? Math.max(1, Math.min(args.maxElements, 500)) : 150
  const nodes = frameInteractiveCandidates(root)
  const visible = nodes.filter(element => args.includeHidden === true || frameIsVisible(element))
  const elements = visible.slice(0, max).map(element => {
    const input = element instanceof HTMLInputElement ? element : null
    const sensitive = input !== null && (
      input.type === 'password'
      || FRAME_SENSITIVE_INPUT.test(input.name)
      || FRAME_SENSITIVE_INPUT.test(input.id)
      || FRAME_SENSITIVE_INPUT.test(input.autocomplete)
    )
    return frameClean({
      tag: element.tagName.toLowerCase(),
      role: frameSemanticRole(element),
      text: frameCompactText(
        element.getAttribute('title')
        || element.innerText
        || element.textContent
        || element.getAttribute('aria-label')
        || '',
        240,
      ),
      selector: frameStableSelector(element),
      type: input?.type || undefined,
      name: input?.name || undefined,
      href: element instanceof HTMLAnchorElement ? element.href : undefined,
      checked: input && ['checkbox', 'radio'].includes(input.type) ? input.checked : undefined,
      value: sensitive || input === null ? undefined : frameCompactText(input.value, 120) || undefined,
    })
  })
  return {
    ok: true,
    url: location.href,
    title: document.title,
    elements,
    truncated: visible.length > elements.length,
  }
}

function frameReadPage(args) {
  const root = frameSelectRoot(args.selector)
  const maxChars = Number.isInteger(args.maxChars) ? Math.max(100, Math.min(args.maxChars, 100000)) : 20000
  const text = String(root.innerText || root.textContent || '').replace(/\u0000/g, '').trim()
  const tables = frameExtractTables(root)
  return {
    ok: true,
    url: location.href,
    title: document.title,
    text: text.slice(0, maxChars),
    truncated: text.length > maxChars,
    tables,
  }
}

function frameCount(args) {
  if (typeof args.selector !== 'string' || !args.selector) throw new Error('count requires selector')
  const nodes = [...document.querySelectorAll(args.selector)]
  const count = args.visibleOnly === true ? nodes.filter(frameIsVisible).length : nodes.length
  return { ok: true, selector: args.selector, count, visibleOnly: args.visibleOnly === true }
}

function frameClick(args) {
  const element = frameRequiredElement(args.selector)
  if (!frameIsVisible(element)) throw new Error(`element is not visible: ${args.selector}`)
  element.scrollIntoView({ block: 'center', inline: 'center' })
  frameDispatchRealisticClick(element)
  return {
    ok: true,
    selector: args.selector,
    tag: element.tagName.toLowerCase(),
    text: frameCompactText(element.getAttribute('title') || element.innerText || element.textContent || '', 240),
  }
}

function frameType(args) {
  const element = frameRequiredElement(args.selector)
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable)) {
    throw new Error(`element is not editable: ${args.selector}`)
  }
  const text = String(args.text ?? '')
  element.focus()
  if (element.isContentEditable) {
    if (args.clear !== false) element.textContent = ''
    element.textContent = `${element.textContent || ''}${text}`
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true, selector: args.selector }
  }
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  const nextValue = args.clear === false ? `${element.value || ''}${text}` : text
  if (setter) setter.call(element, nextValue)
  else element.value = nextValue
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
  return { ok: true, selector: args.selector }
}

function framePress(args) {
  const element = args.selector ? frameRequiredElement(args.selector) : (document.activeElement || document.body)
  const key = String(args.key || '')
  if (!key) throw new Error('press requires key')
  element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  element.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }))
  return { ok: true, key }
}

function frameScroll(args) {
  const direction = String(args.direction || 'down')
  const amount = Number.isFinite(Number(args.amount)) ? Math.max(1, Math.abs(Number(args.amount))) : 600
  const target = args.selector ? frameRequiredElement(args.selector) : window
  if (target === window) {
    if (direction === 'top') window.scrollTo({ top: 0, behavior: 'instant' })
    else if (direction === 'bottom') window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' })
    else if (direction === 'up') window.scrollBy({ top: -amount, behavior: 'instant' })
    else if (direction === 'down') window.scrollBy({ top: amount, behavior: 'instant' })
    else if (direction === 'left') window.scrollBy({ left: -amount, behavior: 'instant' })
    else if (direction === 'right') window.scrollBy({ left: amount, behavior: 'instant' })
  } else {
    if (direction === 'top') target.scrollTop = 0
    else if (direction === 'bottom') target.scrollTop = target.scrollHeight
    else if (direction === 'up') target.scrollTop -= amount
    else if (direction === 'down') target.scrollTop += amount
    else if (direction === 'left') target.scrollLeft -= amount
    else if (direction === 'right') target.scrollLeft += amount
  }
  return { ok: true, x: window.scrollX, y: window.scrollY }
}

async function frameWait(args) {
  const timeoutMs = Number.isInteger(args.timeoutMs) ? Math.max(0, Math.min(args.timeoutMs, 60000)) : 10000
  if (!args.selector) {
    await frameSleep(timeoutMs)
    return { ok: true, found: true, timeoutMs }
  }
  const condition = args.condition === 'gone' ? 'gone' : 'visible'
  const deadline = Date.now() + timeoutMs
  do {
    let element = null
    try { element = document.querySelector(args.selector) } catch { throw new Error(`invalid selector: ${args.selector}`) }
    const visible = !!element && frameIsVisible(element)
    if ((condition === 'visible' && visible) || (condition === 'gone' && !visible)) {
      return { ok: true, found: true, selector: args.selector, timeoutMs }
    }
    if (Date.now() >= deadline) break
    await frameSleep(120)
  } while (true)
  return { ok: true, found: false, selector: args.selector, timeoutMs }
}

function frameExtractTables(root) {
  const candidates = [...root.querySelectorAll('table')]
    .map((table, index) => ({ table, index, score: frameTableScore(table) }))
    .filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 8)

  const result = []
  for (const { table } of candidates) {
    const rows = frameDataRows(table).slice(0, 50)
    if (rows.length === 0) continue
    const extractedRows = []
    for (const row of rows) {
      const cells = [...row.children].filter(cell => /^(TD|TH)$/.test(cell.tagName))
      const extractedCells = []
      for (let index = 0; index < Math.min(cells.length, 30); index += 1) {
        const cell = cells[index]
        const value = frameCellValue(cell)
        const column = frameCellHeader(cell, table, index)
        const clickable = frameClickableDescendant(cell)
        extractedCells.push(frameClean({
          column: column || `column-${index + 1}`,
          value,
          hidden: !frameIsRendered(cell),
          clickSelector: clickable ? frameStableSelector(clickable) : undefined,
        }))
      }
      if (extractedCells.some(cell => cell.value)) extractedRows.push({ cells: extractedCells })
    }
    if (extractedRows.length === 0) continue
    result.push(frameClean({
      id: table.id || undefined,
      selector: frameStableSelector(table),
      rows: extractedRows,
    }))
  }
  return result
}

function frameTableScore(table) {
  const role = String(table.getAttribute('role') || '').toLowerCase()
  const className = typeof table.className === 'string' ? table.className : ''
  const rows = frameDataRows(table)
  const headerCount = table.querySelectorAll('thead th,[role="columnheader"]').length
  let score = 0
  if (role === 'grid') score += 20
  if (/jqgrid|jqg|grid/i.test(`${className} ${table.id || ''}`)) score += 16
  if (headerCount >= 2) score += 8
  if (rows.length >= 2) score += 6
  if (rows.some(row => row.querySelectorAll('td').length >= 3)) score += 5
  const formControls = table.querySelectorAll('input,select,textarea,button').length
  if (formControls >= 3 && role !== 'grid' && !/jqgrid|jqg|grid/i.test(`${className} ${table.id || ''}`)) score -= 10
  return score
}

function frameDataRows(table) {
  return [...table.querySelectorAll('tr')].filter(row => {
    const className = typeof row.className === 'string' ? row.className : ''
    if (/jqgfirstrow|ui-jqgrid-labels/.test(className)) return false
    if (String(row.getAttribute('role') || '').toLowerCase() === 'rowheader') return false
    const cells = [...row.children].filter(cell => /^(TD|TH)$/.test(cell.tagName))
    return cells.length > 0 && cells.some(cell => frameCellValue(cell) !== '')
  })
}

function frameCellValue(cell) {
  const title = frameCompactText(cell.getAttribute('title') || '', 1000)
  if (title) return title
  return frameCompactText(cell.textContent || cell.innerText || '', 1000)
}

function frameCellHeader(cell, table, index) {
  const describedBy = frameCompactText(cell.getAttribute('aria-describedby') || '', 200)
  if (describedBy) {
    for (const id of describedBy.split(/\s+/)) {
      const header = document.getElementById(id)
      const text = frameCompactText(header?.textContent || header?.innerText || '', 200)
      if (text) return text
    }
  }
  const headers = frameCompactText(cell.getAttribute('headers') || '', 200)
  if (headers) {
    for (const id of headers.split(/\s+/)) {
      const header = document.getElementById(id)
      const text = frameCompactText(header?.textContent || header?.innerText || '', 200)
      if (text) return text
    }
  }
  const localHeaders = [...table.querySelectorAll('thead th')]
  const local = localHeaders[index]
  return frameCompactText(local?.textContent || local?.innerText || '', 200)
}

function frameClickableDescendant(cell) {
  if (cell.matches?.(FRAME_BASE_INTERACTIVE_SELECTOR) && frameIsVisible(cell)) return cell
  return [...cell.querySelectorAll(FRAME_BASE_INTERACTIVE_SELECTOR)].find(frameIsVisible)
}

function frameInteractiveCandidates(root) {
  const selector = `${FRAME_BASE_INTERACTIVE_SELECTOR},${FRAME_CUSTOM_INTERACTIVE_SELECTOR}`
  const nodes = [...root.querySelectorAll(selector)]
  return nodes.filter(element => element.matches(FRAME_BASE_INTERACTIVE_SELECTOR) || frameLikelyClickable(element))
}

function frameLikelyClickable(element) {
  const tabindex = element.getAttribute('tabindex')
  if (tabindex !== null && Number(tabindex) >= 0) return true
  const style = getComputedStyle(element)
  const label = frameCompactText(
    element.getAttribute('title')
    || element.innerText
    || element.textContent
    || element.getAttribute('aria-label')
    || '',
    160,
  )
  if (!label) return false
  if (style.cursor === 'pointer') return true
  return FRAME_ACTION_TEXT_HINT.test(label)
}

function frameSemanticRole(element) {
  const explicit = element.getAttribute('role')
  if (explicit) return explicit
  const tag = element.tagName.toLowerCase()
  if (tag === 'button') return 'button'
  if (tag === 'a' && element.getAttribute('href')) return 'link'
  if (element instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(element.type)) return 'button'
  if (frameLikelyClickable(element)) return 'button'
  return undefined
}

function frameStableSelector(element) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) throw new Error('cannot build selector for non-element')
  if (element.id) return `#${frameCssEscape(element.id)}`
  const parts = []
  let node = element
  let depth = 0
  while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement && depth < 8) {
    if (node.id) {
      parts.unshift(`#${frameCssEscape(node.id)}`)
      break
    }
    const tag = node.tagName.toLowerCase()
    let part = tag
    const parent = node.parentElement
    if (parent) {
      const sameTag = [...parent.children].filter(child => child.tagName === node.tagName)
      if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`
    }
    parts.unshift(part)
    node = parent
    depth += 1
  }
  return parts.join(' > ')
}

function frameCssEscape(value) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return String(value).replace(/([^a-zA-Z0-9_-])/g, '\\$1')
}

function frameSelectRoot(selector) {
  if (!selector) return document.body || document.documentElement
  return frameRequiredElement(selector)
}

function frameRequiredElement(selector) {
  if (typeof selector !== 'string' || !selector) throw new Error('selector is required')
  let element
  try { element = document.querySelector(selector) } catch { throw new Error(`invalid selector: ${selector}`) }
  if (!element) throw new Error(`element not found: ${selector}`)
  return element
}

function frameIsRendered(element) {
  if (!element) return false
  const style = getComputedStyle(element)
  return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0
}

function frameIsVisible(element) {
  if (!frameIsRendered(element)) return false
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return false
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0
  if (viewportWidth > 0 && viewportHeight > 0) {
    if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= viewportWidth || rect.top >= viewportHeight) return false
  }
  return true
}

function frameDispatchRealisticClick(element) {
  const rect = element.getBoundingClientRect()
  const x = Math.max(rect.left + 1, Math.min(rect.left + rect.width / 2, rect.right - 1))
  const y = Math.max(rect.top + 1, Math.min(rect.top + rect.height / 2, rect.bottom - 1))
  element.focus?.({ preventScroll: true })
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
    const event = type.startsWith('pointer') && typeof PointerEvent !== 'undefined'
      ? new PointerEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true })
      : new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 })
    element.dispatchEvent(event)
  }
  if (typeof element.click === 'function') element.click()
  else element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 }))
}

function frameCompactText(value, max) {
  return String(value || '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function frameClean(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''))
}

function frameSafeError(error) {
  const text = error && typeof error.message === 'string' ? error.message : String(error)
  return text.replace(/(password|passwd|pwd|token|secret|authorization|cookie|otp|captcha|验证码)\s*[:=：]\s*\S+/gi, '$1=[REDACTED]')
}

function frameSleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }
