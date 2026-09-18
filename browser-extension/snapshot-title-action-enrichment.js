// Read-only snapshot enrichment for enterprise UIs that render actions as
// title-backed spans/divs instead of native anchors or buttons. This layer does
// not click anything; it only makes CURRENT action evidence visible to Patrol so
// callers do not invent an <a> selector for a DOM node that is actually a span.

const snapshotTitleActionPreviousSendDomCommand = sendDomCommand

sendDomCommand = async function snapshotTitleActionSendDomCommand(cmd, args = {}) {
  const result = await snapshotTitleActionPreviousSendDomCommand(cmd, args)
  if (cmd !== 'snapshot' || !result || result.ok === false || !chrome.scripting?.executeScript) return result

  const tabId = await resolveTabId(args.tabId)
  const max = Number.isInteger(args.maxElements) ? Math.max(1, Math.min(args.maxElements, 500)) : 150
  let frames = []
  try { frames = await patrolFrames(tabId) } catch { frames = [{ frameId: 0, parentFrameId: -1, url: '' }] }
  const extras = []

  for (const frame of frames) {
    if (extras.length >= 40) break
    let values
    try {
      values = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frame.frameId] },
        world: 'MAIN',
        func: snapshotTitleActionCollect,
      })
    } catch {
      continue
    }
    const value = Array.isArray(values) ? values[0]?.result : undefined
    for (const item of Array.isArray(value?.elements) ? value.elements : []) {
      if (!item || typeof item !== 'object' || typeof item.selector !== 'string' || !item.selector) continue
      const selector = frame.frameId === 0
        ? `top-frame::${item.selector}`
        : (() => {
            const frameUrl = typeof stableFrameUrl === 'function' ? stableFrameUrl(frame.url || '') : String(frame.url || '').split(/[?#]/, 1)[0]
            return frameUrl ? `frame-url(${encodeURIComponent(frameUrl)})::${item.selector}` : item.selector
          })()
      extras.push({ ...item, selector })
      if (extras.length >= 40) break
    }
  }

  const base = Array.isArray(result.elements) ? result.elements : []
  const seen = new Set(base.map(item => item && typeof item === 'object' ? String(item.selector || '') : '').filter(Boolean))
  const merged = [...base]
  for (const item of extras) {
    if (seen.has(item.selector)) continue
    seen.add(item.selector)
    // Action evidence is intentionally appended even when the ordinary snapshot
    // hit its generic max. Keep only a small bounded enrichment budget.
    merged.push(item)
  }
  return {
    ...result,
    elements: merged.slice(0, Math.max(max, Math.min(max + 40, merged.length))),
    actionEvidenceEnriched: extras.length > 0,
  }
}

// Serialized into the page MAIN world. Read-only and self-contained.
function snapshotTitleActionCollect() {
  const compact = (value, limit = 240) => {
    const text = String(value || '').replace(/\s+/g, ' ').trim()
    return text.length > limit ? `${text.slice(0, limit)}…` : text
  }
  const cssEscape = value => globalThis.CSS?.escape
    ? CSS.escape(String(value))
    : String(value).replace(/[^a-zA-Z0-9_-]/g, char => `\\${char}`)
  const cssString = value => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const visible = element => {
    if (!(element instanceof Element) || !element.isConnected) return false
    const style = getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }
  const unique = selector => {
    try { return document.querySelectorAll(selector).length === 1 } catch { return false }
  }
  const treeActionTarget = element => {
    if (!(element instanceof Element)) return null
    const target = element.closest?.('.ant-tree-node-content-wrapper,[role="treeitem"]')
    return target instanceof Element && visible(target) ? target : null
  }
  const treeNodeLabel = node => compact(
    node?.querySelector?.('[title]')?.getAttribute?.('title')
      || node?.querySelector?.('.ant-tree-title')?.innerText
      || node?.innerText
      || node?.textContent
      || '',
    100,
  )
  const treeNodeDepth = node => {
    if (!(node instanceof Element)) return 0
    const ariaLevel = Number(node.getAttribute('aria-level'))
    if (Number.isFinite(ariaLevel) && ariaLevel > 0) return ariaLevel - 1
    const indent = node.querySelector(':scope > .ant-tree-indent')
    return indent instanceof Element ? indent.children.length : 0
  }
  const treeContext = element => {
    const node = element.closest?.('.ant-tree-treenode,[role="treeitem"]')
    if (!(node instanceof Element)) return ''
    const tree = node.closest?.('.ant-tree,[role="tree"]') || node.parentElement
    if (!(tree instanceof Element)) return treeNodeLabel(node)
    const nodes = [...tree.querySelectorAll('.ant-tree-treenode,[role="treeitem"]')].filter(visible)
    const index = nodes.indexOf(node)
    const path = [treeNodeLabel(node)].filter(Boolean)
    let wantedDepth = treeNodeDepth(node)
    for (let cursor = index - 1; cursor >= 0 && wantedDepth > 0; cursor -= 1) {
      const candidate = nodes[cursor]
      const depth = treeNodeDepth(candidate)
      if (depth < wantedDepth) {
        const label = treeNodeLabel(candidate)
        if (label) path.unshift(label)
        wantedDepth = depth
      }
    }
    if (path.length === 1 && index > 0) {
      const previous = treeNodeLabel(nodes[index - 1])
      if (previous && previous !== path[0]) path.unshift(previous)
    }
    return compact(path.join(' > ') || tree.innerText || tree.textContent || '', 260)
  }
  const pathSelector = element => {
    if (element.id) return `#${cssEscape(element.id)}`
    const title = element.getAttribute('title')
    if (title) {
      const byTitle = `${element.tagName.toLowerCase()}[title="${cssString(title)}"]`
      if (unique(byTitle)) return byTitle
      const row = element.closest('tr,[role="row"],.ant-table-row,.el-table__row,.arco-table-tr,[data-row-key],[aria-rowindex]')
      if (row instanceof Element) {
        let rowSelector = ''
        const rowKey = row.getAttribute('data-row-key')
        const ariaIndex = row.getAttribute('aria-rowindex')
        if (rowKey) rowSelector = `[data-row-key="${cssString(rowKey)}"]`
        else if (ariaIndex) rowSelector = `[aria-rowindex="${cssString(ariaIndex)}"]`
        else if (row.parentElement) {
          const peers = [...row.parentElement.children].filter(child => child.tagName === row.tagName)
          const ordinal = peers.indexOf(row)
          if (ordinal >= 0) rowSelector = `${row.tagName.toLowerCase()}:nth-of-type(${ordinal + 1})`
        }
        if (rowSelector) {
          const candidate = `${rowSelector} ${byTitle}`
          if (unique(candidate)) return candidate
        }
      }
    }
    const parts = []
    let node = element
    while (node instanceof Element && node !== document.documentElement && parts.length < 9) {
      let part = node.tagName.toLowerCase()
      const parent = node.parentElement
      if (parent) {
        const peers = [...parent.children].filter(child => child.tagName === node.tagName)
        if (peers.length > 1) part += `:nth-of-type(${peers.indexOf(node) + 1})`
      }
      parts.unshift(part)
      const candidate = parts.join(' > ')
      if (unique(candidate)) return candidate
      node = parent
    }
    return parts.join(' > ')
  }

  const nodes = [...document.querySelectorAll('[title]')]
    .filter(visible)
    .filter(element => {
      const title = compact(element.getAttribute('title'), 160)
      if (!title || title.length > 80) return false
      const style = getComputedStyle(element)
      return style.cursor === 'pointer'
        || /\[[^\]]{1,24}\]|\b[A-Z]{2,8}\b|登录|访问|打开|连接|进入|查看|详情|配置|下载|确定|提交/i.test(title)
        || treeActionTarget(element) !== null
    })
    .slice(0, 40)

  return {
    elements: nodes.map(element => {
      const row = element.closest('tr,[role="row"],.ant-table-row,.el-table__row,.arco-table-tr,[data-row-key],[aria-rowindex]')
      const explicitRole = element.getAttribute('role')
      return {
        tag: element.tagName.toLowerCase(),
        ...(explicitRole ? { role: explicitRole } : {}),
        text: compact(element.getAttribute('title') || element.innerText || element.textContent || '', 160),
        selector: pathSelector(element),
        context: compact(row?.innerText || row?.textContent || treeContext(element), 260),
        evidence: treeActionTarget(element) === null ? 'title-backed-custom-action' : 'title-backed-tree-action',
      }
    }),
  }
}
