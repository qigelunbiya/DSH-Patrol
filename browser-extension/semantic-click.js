// Atomic semantic click transport for DSH Patrol.
//
// This deliberately resolves the semantic target and performs the click inside
// one extension command. It does not depend on a content-script page bridge, so
// a CURRENT snapshot cannot go stale or acquire the wrong frame scope between
// "find" and "click". The command probes every accessible document with
// chrome.scripting in MAIN world, requires one globally best target, then
// re-resolves that target in the chosen frame immediately before clicking.

const semanticClickPreviousHandleCommand = handleCommand

handleCommand = async function semanticClickHandleCommand(cmd, args = {}) {
  if (cmd === 'semanticClick') return await semanticClickCommand(args)
  return await semanticClickPreviousHandleCommand(cmd, args)
}

async function semanticClickCommand(args) {
  if (!chrome.scripting?.executeScript) throw new Error('semantic click requires chrome.scripting.executeScript')
  const tabId = await resolveTabId(args.tabId)
  const spec = semanticSerializableSpec(args)
  if (!spec.locatorText && !spec.selectorHint && !spec.task) {
    throw new Error('semanticClick requires locatorText, selectorHint, or task context')
  }

  const frames = await semanticClickFrames(tabId)
  const candidates = []
  for (const frame of frames) {
    try {
      const result = await semanticClickExecute(tabId, frame.frameId, 'probe', spec)
      for (const candidate of Array.isArray(result?.candidates) ? result.candidates : []) {
        if (!candidate || typeof candidate !== 'object') continue
        candidates.push({ frame, candidate })
      }
    } catch {
      // Browser-internal frames may reject MAIN-world execution. Other frames
      // remain eligible; absence in one inaccessible frame is not a reason to
      // fall back to the fragile content-script bridge.
    }
  }

  if (candidates.length === 0) {
    throw new Error(`atomic semantic target not found for ${semanticDescribeSpec(spec)}`)
  }
  candidates.sort((left, right) => Number(right.candidate.score || 0) - Number(left.candidate.score || 0))
  const bestScore = Number(candidates[0]?.candidate?.score || 0)
  const best = candidates.filter(item => Number(item.candidate.score || 0) === bestScore)
  if (best.length !== 1) {
    const details = best.slice(0, 6).map(item => `${item.frame.frameId}:${String(item.candidate.text || item.candidate.selector || '?')}`).join(', ')
    throw new Error(`atomic semantic target is ambiguous (${best.length} equally ranked candidates): ${details}`)
  }

  const chosen = best[0]
  const tabsBefore = await semanticClickTabBaseline(tabId)
  const clickSpec = {
    ...spec,
    expectedFingerprint: chosen.candidate.fingerprint,
  }

  let clicked
  let transport = 'atomic-main-world-semantic-click'
  if (chosen.frame.frameId === 0 && semanticTrustedMouseAvailable()) {
    const measured = await semanticClickExecute(tabId, 0, 'measure', clickSpec)
    const x = Number(measured?.clientX)
    const y = Number(measured?.clientY)
    if (Number.isFinite(x) && Number.isFinite(y)) {
      const native = await semanticTrustedMouseClick(tabId, x, y)
      if (native.ok) {
        await new Promise(resolve => setTimeout(resolve, 260))
        let after
        try { after = await semanticClickExecute(tabId, 0, 'measure', clickSpec) } catch {}
        const beforeSignature = typeof measured?.stateSignature === 'string' ? measured.stateSignature : ''
        const afterSignature = typeof after?.stateSignature === 'string' ? after.stateSignature : ''
        const targetStateChanged = after === undefined
          ? true
          : Boolean(beforeSignature && afterSignature && beforeSignature !== afterSignature)
        clicked = {
          ...measured,
          ...(after && typeof after === 'object' ? after : {}),
          ok: true,
          targetStateChanged,
          stateEvidence: after === undefined
            ? 'trusted semantic click target detached/re-rendered'
            : targetStateChanged
              ? 'trusted semantic click changed the target own business state'
              : '',
        }
        transport = 'atomic-semantic+trusted-native-mouse'
      } else if (native.partial) {
        throw new Error(`trusted semantic click partially dispatched; refusing a second click: ${native.error || 'unknown native input failure'}`)
      }
    }
  }

  if (clicked === undefined) {
    clicked = await semanticClickExecute(tabId, chosen.frame.frameId, 'click', clickSpec)
  }
  if (!clicked || clicked.ok === false) throw new Error(String(clicked?.error || 'atomic semantic click failed'))
  const opened = await semanticClickAdoptSingleOpenedTab(tabId, tabsBefore)

  const innerSelector = typeof clicked.selector === 'string' ? clicked.selector : String(chosen.candidate.selector || '')
  const scopedSelector = semanticScopeSelector(chosen.frame, innerSelector)
  return {
    ok: true,
    selector: scopedSelector,
    text: String(clicked.text || chosen.candidate.text || ''),
    role: String(clicked.role || chosen.candidate.role || ''),
    tag: String(clicked.tag || chosen.candidate.tag || ''),
    replaySelectorSafe: clicked.replaySelectorSafe !== false,
    frameId: chosen.frame.frameId,
    frameUrl: chosen.frame.url || '',
    transport,
    targetStateChanged: clicked.targetStateChanged === true,
    ...(opened ? {
      openedTabId: opened.id,
      openedTabUrl: typeof opened.url === 'string' ? opened.url : '',
      stateEvidence: `semantic click opened child tab ${opened.id}${opened.url ? ` (${opened.url})` : ''}`,
    } : (typeof clicked.stateEvidence === 'string' && clicked.stateEvidence ? { stateEvidence: clicked.stateEvidence } : {})),
  }
}

function semanticTrustedMouseAvailable() {
  return Boolean(chrome.debugger?.attach && chrome.debugger?.sendCommand && chrome.debugger?.detach)
}

async function semanticTrustedMouseClick(tabId, x, y) {
  const target = { tabId }
  let attached = false
  let sent = 0
  try {
    await chrome.debugger.attach(target, '1.3')
    attached = true
    const events = [
      { type: 'mouseMoved', x, y, button: 'none', buttons: 0 },
      { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 },
      { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 },
    ]
    for (const params of events) {
      await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', params)
      sent += 1
    }
    return { ok: true, partial: false }
  } catch (error) {
    return {
      ok: false,
      partial: sent > 0,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    if (attached) {
      try { await chrome.debugger.detach(target) } catch {}
    }
  }
}

function semanticSerializableSpec(args) {
  const out = {}
  for (const key of ['locatorText', 'locatorRole', 'locatorTag', 'selectorHint', 'task']) {
    if (typeof args?.[key] === 'string' && args[key].trim()) out[key] = args[key].trim()
  }
  return out
}

async function semanticClickTabBaseline(sourceTabId) {
  if (!chrome.tabs?.query) return undefined
  try {
    const source = chrome.tabs.get ? await chrome.tabs.get(sourceTabId) : undefined
    const tabs = await chrome.tabs.query({})
    return {
      ids: new Set((Array.isArray(tabs) ? tabs : []).map(tab => tab?.id).filter(Number.isInteger)),
      windowId: Number.isInteger(source?.windowId) ? source.windowId : undefined,
    }
  } catch {
    return undefined
  }
}

async function semanticClickAdoptSingleOpenedTab(sourceTabId, baseline) {
  if (!baseline?.ids || !chrome.tabs?.query) return undefined
  for (const delayMs of [0, 80, 180, 320]) {
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs))
    let tabs
    try { tabs = await chrome.tabs.query({}) } catch { return undefined }
    const fresh = (Array.isArray(tabs) ? tabs : []).filter(tab => Number.isInteger(tab?.id) && !baseline.ids.has(tab.id))
    const children = fresh.filter(tab => tab.openerTabId === sourceTabId)
    const sameWindow = fresh.filter(tab => baseline.windowId === undefined || tab.windowId === baseline.windowId)
    const candidates = children.length > 0 ? children : sameWindow
    if (candidates.length !== 1) {
      if (fresh.length > 1 || children.length > 1) return undefined
      continue
    }
    const opened = candidates[0]
    try { await chrome.tabs.update(opened.id, { active: true }) } catch {}
    return opened
  }
  return undefined
}

async function semanticClickFrames(tabId) {
  let frames = []
  try { frames = await chrome.webNavigation.getAllFrames({ tabId }) || [] } catch { frames = [] }
  if (!Array.isArray(frames) || frames.length === 0) frames = [{ frameId: 0, parentFrameId: -1, url: '' }]
  return frames
    .filter(frame => Number.isInteger(frame?.frameId))
    .map(frame => ({ frameId: frame.frameId, parentFrameId: Number.isInteger(frame.parentFrameId) ? frame.parentFrameId : -1, url: typeof frame.url === 'string' ? frame.url : '' }))
    .sort((left, right) => left.frameId - right.frameId)
}

async function semanticClickExecute(tabId, frameId, mode, spec) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    world: 'MAIN',
    func: semanticClickPageCommand,
    args: [mode, spec],
  })
  const value = Array.isArray(results) ? results[0]?.result : undefined
  if (!value || typeof value !== 'object') throw new Error(`semantic click returned no result in frame ${frameId}`)
  return value
}

function semanticScopeSelector(frame, selector) {
  if (!selector) return ''
  if (frame.frameId === 0) return `top-frame::${selector}`
  const url = typeof stableFrameUrl === 'function' ? stableFrameUrl(frame.url || '') : String(frame.url || '').split('#')[0].split('?')[0]
  return url ? `frame-url(${encodeURIComponent(url)})::${selector}` : selector
}

function semanticDescribeSpec(spec) {
  return JSON.stringify({ text: spec.locatorText || '', role: spec.locatorRole || '', tag: spec.locatorTag || '', task: spec.task || '' })
}

// Serialized into the page MAIN world. Keep self-contained.
async function semanticClickPageCommand(mode, spec) {
  const compact = value => String(value || '').replace(/\s+/g, ' ').trim()
  const normalize = value => compact(value).replace(/\s+/g, '').toLocaleLowerCase()
  const cssEscape = value => globalThis.CSS?.escape ? CSS.escape(String(value)) : String(value).replace(/[^a-zA-Z0-9_-]/g, char => `\\${char}`)
  const visible = element => {
    if (!(element instanceof Element) || !element.isConnected) return false
    const style = getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }
  const disabled = element => element.matches?.(':disabled,[aria-disabled="true"]') === true
  const deepQueryAll = (selector, startRoot = document) => {
    const out = []
    const roots = [startRoot]
    const seenRoots = new Set()
    let scannedElements = 0
    while (roots.length && seenRoots.size < 64 && scannedElements < 12000) {
      const root = roots.shift()
      if (!root || seenRoots.has(root) || typeof root.querySelectorAll !== 'function') continue
      seenRoots.add(root)
      try { out.push(...root.querySelectorAll(selector)) } catch { return [] }
      let elements = []
      try { elements = [...root.querySelectorAll('*')] } catch {}
      scannedElements += elements.length
      for (const element of elements) {
        if (element?.shadowRoot && !seenRoots.has(element.shadowRoot)) roots.push(element.shadowRoot)
      }
    }
    return [...new Set(out)]
  }
  const actionText = element => {
    const parts = [element.getAttribute?.('aria-label'), element.getAttribute?.('title'), element.getAttribute?.('placeholder')]
    if (element instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(String(element.type || '').toLowerCase())) parts.push(element.value)
    if (element instanceof HTMLImageElement) parts.push(element.getAttribute('alt'), element.getAttribute('src'))
    parts.push(element.innerText, element.textContent)
    for (const img of deepQueryAll('img', element)) parts.push(img.getAttribute('alt'), img.getAttribute('title'))
    return compact(parts.filter(Boolean).join(' '))
  }
  const roleOf = element => {
    const explicit = compact(element.getAttribute?.('role') || '')
    if (explicit) return explicit
    if (element.tagName === 'A') return 'link'
    if (element.tagName === 'BUTTON') return 'button'
    if (element instanceof HTMLTextAreaElement || element?.isContentEditable === true) return 'textbox'
    if (element instanceof HTMLInputElement) {
      return ['button', 'submit', 'reset'].includes(String(element.type || '').toLowerCase()) ? 'button' : 'textbox'
    }
    return ''
  }
  const stableSelector = element => {
    const selectorRoot = element.getRootNode?.() || document
    const uniqueInRoot = selector => {
      try { return typeof selectorRoot.querySelectorAll === 'function' && selectorRoot.querySelectorAll(selector).length === 1 } catch { return false }
    }
    if (element.id) {
      const byId = `#${cssEscape(element.id)}`
      if (uniqueInRoot(byId)) return byId
    }
    for (const attr of ['data-testid', 'data-test', 'data-cy', 'name', 'menuid', 'aria-label', 'title', 'placeholder']) {
      const value = element.getAttribute?.(attr)
      if (value) {
        const candidate = `${element.tagName.toLowerCase()}[${attr}="${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`
        if (uniqueInRoot(candidate)) return candidate
      }
    }
    const classes = [...(element.classList || [])].filter(name => /^[A-Za-z_-][A-Za-z0-9_-]*$/.test(name)).slice(0, 2)
    if (classes.length) {
      const selector = `${element.tagName.toLowerCase()}.${classes.map(cssEscape).join('.')}`
      try { if (uniqueInRoot(selector)) return selector } catch {}
    }
    const path = []
    let node = element
    while (node instanceof Element && node !== document.documentElement && path.length < 7) {
      let part = node.tagName.toLowerCase()
      const parent = node.parentElement
      if (parent) {
        const same = [...parent.children].filter(child => child.tagName === node.tagName)
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`
      }
      path.unshift(part)
      const candidate = path.join(' > ')
      try { if (uniqueInRoot(candidate)) return candidate } catch {}
      node = parent
    }
    return path.join(' > ')
  }
  const fingerprint = element => `${stableSelector(element)}|${normalize(actionText(element))}|${normalize(roleOf(element))}|${element.tagName.toLowerCase()}`
  const stateSignature = element => {
    if (!(element instanceof Element)) return ''
    const statefulClasses = [...(element.classList || [])]
      .filter(token => /(?:^|[-_])(active|selected|checked|pressed|liked|on)(?:$|[-_])|^(?:is|has)-(?:active|selected|checked|pressed|liked|on)$/i.test(token))
      .sort()
      .join(' ')
    return [
      element.tagName.toLowerCase(),
      statefulClasses,
      compact(element.getAttribute?.('aria-pressed') || ''),
      compact(element.getAttribute?.('aria-checked') || ''),
      compact(element.getAttribute?.('aria-expanded') || ''),
      compact(element.getAttribute?.('data-state') || ''),
      compact(element.getAttribute?.('title') || ''),
      compact(element.getAttribute?.('value') || ''),
      compact(element.innerText || element.textContent || '').slice(0, 320),
    ].join('|')
  }
  const interactiveAncestorSelector = [
    'a[href]', 'button', 'input[type="button"]', 'input[type="submit"]', 'input[type="reset"]',
    '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="tab"]',
    '[onclick]', '[bg-click]', '[ng-click]', '[data-action]', '[tabindex]:not([tabindex="-1"])',
  ].join(',')
  const physicalClickTarget = element => {
    const title = compact(element.getAttribute?.('title') || '')
    if (title) {
      const treeWrapper = element.closest?.('.ant-tree-node-content-wrapper,[role="treeitem"]')
      if (treeWrapper instanceof Element && visible(treeWrapper) && !disabled(treeWrapper)) return treeWrapper
    }
    const interactive = element.closest?.(interactiveAncestorSelector)
    if (interactive instanceof Element && visible(interactive) && !disabled(interactive)) return interactive
    let node = element.parentElement
    for (let depth = 0; node instanceof Element && depth < 6; depth += 1, node = node.parentElement) {
      if (visible(node) && !disabled(node) && getComputedStyle(node).cursor === 'pointer') return node
    }
    return element
  }
  const persistedClickTarget = (element, clickTarget) => {
    const title = compact(element.getAttribute?.('title') || '')
    const treeWrapper = title ? element.closest?.('.ant-tree-node-content-wrapper,[role="treeitem"]') : null
    // Keep the titled Ant-tree leaf for replay because content.js knows how to
    // re-promote it. For ordinary cards/headings persist the real interactive
    // ancestor (for example Bilibili h3[title] -> enclosing a[href]).
    return treeWrapper === clickTarget ? element : clickTarget
  }
  const wantedText = normalize(spec.locatorText || '')
  const wantedRole = normalize(spec.locatorRole || '')
  const wantedTag = normalize(spec.locatorTag || '')
  const semanticIntentText = String(`${spec.locatorText || ''} ${spec.task || ''}`)
  const wantsCommentEditor = /评论.*(?:输入|编辑)|回复.*(?:输入|编辑)|输入框|编辑框|comment.*(?:input|editor)|reply.*(?:input|editor)/i.test(semanticIntentText)
  const editableCandidate = element => element instanceof HTMLInputElement
    || element instanceof HTMLTextAreaElement
    || element?.isContentEditable === true
    || normalize(element.getAttribute?.('role') || '') === 'textbox'
    || /(?:editor|input|textarea)/i.test(String(element?.tagName || ''))
  const globalExactTitleCandidates = wantedText
    ? deepQueryAll('[title]').filter(element => {
        if (!visible(element) || disabled(element)) return false
        if (normalize(element.getAttribute?.('title') || '') !== wantedText) return false
        if (wantedRole && normalize(roleOf(element)) !== wantedRole) return false
        if (wantedTag && normalize(element.tagName.toLowerCase()) !== wantedTag) return false
        return true
      })
    : []
  // A globally unique CURRENT [title] is authoritative business evidence.
  // Enterprise Ant trees often render one logical row through many nested
  // elements carrying the same innerText. Resolve the unique titled leaf
  // before modal/root scoping so those ancestors cannot become duplicate
  // semantic candidates. The physical click is still promoted only to this
  // leaf's own Ant-tree content wrapper below.
  const uniqueExactTitleTarget = globalExactTitleCandidates.length === 1
    ? globalExactTitleCandidates[0]
    : null

  const modalSelectors = ['[role="dialog"][aria-modal="true"]', '.ant-modal-content', '.el-dialog', '.ivu-modal-content', '.arco-modal', '.semi-modal']
  const modal = modalSelectors.flatMap(selector => deepQueryAll(selector)).find(visible)
  const root = modal || document
  const selector = [
    'a', 'button', 'input[type="button"]', 'input[type="submit"]', 'input[type="reset"]',
    '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="tab"]',
    '[onclick]', '[bg-click]', '[ng-click]', '[data-action]', '[tabindex]:not([tabindex="-1"])',
    'textarea', 'input:not([type="hidden"])', '[contenteditable="true"]', '[role="textbox"]',
    'bili-comment-editor', 'bili-comments',
    '[role="treeitem"]', '.ant-tree-node-content-wrapper', '[title]',
    'img', 'svg', '[id*="logo" i]', '[class*="logo" i]',
  ].join(',')
  const candidates = deepQueryAll(selector, root).filter(element => visible(element) && !disabled(element))
  const exactTitleCandidates = wantedText
    ? candidates.filter(element => normalize(element.getAttribute?.('title') || '') === wantedText)
    : []
  // If F12/DOM evidence shows exactly one visible exact-title leaf in the
  // document, do not let a visible modal root or nested innerText wrappers hide
  // it from the semantic resolver. Otherwise preserve the normal scoped logic.
  const candidatePool = uniqueExactTitleTarget !== null
    ? [uniqueExactTitleTarget]
    : exactTitleCandidates.length > 0
      ? exactTitleCandidates
      : candidates
  const task = normalize(spec.task || '')
  const selectorHint = String(spec.selectorHint || '').replace(/^top-frame::/, '').replace(/^frame-url\([^)]*\)::/, '')
  const ipTokens = String(spec.task || '').match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) || []
  const actionTokens = String(spec.task || '').match(/\b(?:RDP|SSH|VNC|SFTP|FTP|HTTP|HTTPS)\b/gi) || []
  const wantsLogo = /logo|徽标|标志/i.test(String(spec.task || ''))
  const wantsMenu = /菜单|侧栏|汉堡|导航/i.test(String(spec.task || ''))

  const scored = candidatePool.map(element => {
    const text = actionText(element)
    const role = roleOf(element)
    const tag = element.tagName.toLowerCase()
    const normText = normalize(text)
    if (wantedRole && normalize(role) !== wantedRole) return null
    if (wantedTag && normalize(tag) !== wantedTag) return null
    let score = 0
    if (wantedText) {
      // An empty accessible name is never a valid fuzzy match. Without this
      // guard, `wantedText.includes('')` evaluates true and visible shell
      // links/icons can steal clicks from the requested business target.
      if (!normText) return null
      if (normText === wantedText) score += 140
      else if (normText.includes(wantedText) || wantedText.includes(normText)) score += 80
      else if (wantsCommentEditor
        && editableCandidate(element)
        && /评论|回复|comment|reply|editor|textarea|placeholder/.test(normText)) score += 110
      else return null
    }
    if (wantedText) {
      const titleText = normalize(element.getAttribute?.('title') || '')
      if (titleText === wantedText) score += 90
      else if (titleText && titleText.includes(wantedText)) score += 35
      if (element.matches?.('.ant-tree-node-content-wrapper,[role="treeitem"]')) score += 24
    }
    if (selectorHint) {
      try { if (element.matches(selectorHint)) score += 35 } catch {}
    }
    if (['a', 'button'].includes(tag) || role === 'button' || role === 'link' || role === 'menuitem') score += 12
    if (wantsCommentEditor && editableCandidate(element)) score += 80
    if (wantsLogo) {
      const logoEvidence = [
        element.id || '',
        element.getAttribute?.('class') || '',
        element.getAttribute?.('src') || '',
        element.getAttribute?.('href') || '',
        ...deepQueryAll('img,svg', element).map(child => `${child.id || ''} ${child.getAttribute?.('class') || ''} ${child.getAttribute?.('src') || ''}`),
      ].join(' ')
      if (/logo/i.test(logoEvidence)) score += 120
    }
    if (wantsMenu) {
      const menuEvidence = [
        element.id || '',
        element.getAttribute?.('class') || '',
        element.getAttribute?.('aria-label') || '',
        element.getAttribute?.('title') || '',
      ].join(' ')
      if (/menu|sidebar|hamburger|nav|侧栏|菜单|导航/i.test(menuEvidence)) score += 120
    }
    const context = compact(element.closest?.('tr,li,form,nav,[role="dialog"],.ant-modal-content,.el-dialog')?.innerText || '')
    for (const token of ipTokens) if (context.includes(token)) score += 90
    for (const token of actionTokens) if (normalize(text).includes(normalize(token)) || normalize(context).includes(normalize(token))) score += 35
    if (!wantedText && !wantsLogo && task && normalize(`${text} ${context}`).includes(task)) score += 20
    return { element, text, role, tag, score, context }
  }).filter(Boolean).filter(item => item.score > 0)
  scored.sort((left, right) => right.score - left.score)
  if (!scored.length) return { ok: true, candidates: [] }
  const bestScore = scored[0].score
  const best = scored.filter(item => item.score === bestScore)

  if (mode === 'probe') {
    return {
      ok: true,
      candidates: best.slice(0, 8).map(item => ({
        score: item.score,
        selector: stableSelector(item.element),
        text: item.text,
        role: item.role,
        tag: item.tag,
        fingerprint: fingerprint(item.element),
        context: compact(item.context).slice(0, 240),
        evidence: uniqueExactTitleTarget === item.element ? 'unique-exact-title' : 'semantic-score',
      })),
    }
  }
  if (best.length !== 1) throw new Error(`semantic click became ambiguous in selected frame: ${best.length} candidates`)
  const chosen = best[0]
  if (spec.expectedFingerprint && fingerprint(chosen.element) !== spec.expectedFingerprint) {
    // A framework re-render may create a new equivalent node. The semantic
    // fields are authoritative; fingerprint drift alone is not fatal as long as
    // the newly resolved target remains uniquely best.
  }
  const element = chosen.element
  const clickTarget = physicalClickTarget(element)
  const persistedTarget = persistedClickTarget(element, clickTarget)
  clickTarget.scrollIntoView?.({ block: 'center', inline: 'center', behavior: 'instant' })
  const frame = () => new Promise(resolve => requestAnimationFrame(resolve))
  const before = clickTarget.getBoundingClientRect()
  await frame(); await frame()
  if (!element.isConnected || !clickTarget.isConnected) throw new Error('semantic target detached before click')
  const after = clickTarget.getBoundingClientRect()
  if (Math.abs(before.left - after.left) > 1 || Math.abs(before.top - after.top) > 1 || Math.abs(before.width - after.width) > 1 || Math.abs(before.height - after.height) > 1) throw new Error('semantic target is not stable yet')
  const x = Math.max(after.left + 1, Math.min(after.left + after.width / 2, after.right - 1))
  const y = Math.max(after.top + 1, Math.min(after.top + after.height / 2, after.bottom - 1))
  const hit = document.elementFromPoint(x, y)
  if (hit && hit !== clickTarget && !clickTarget.contains(hit)) throw new Error(`semantic target is intercepted by <${hit.tagName.toLowerCase()}>`)
  const descriptor = {
    ok: true,
    selector: stableSelector(persistedTarget),
    replaySelectorSafe: !(persistedTarget.getRootNode?.() instanceof ShadowRoot),
    text: chosen.text,
    role: roleOf(clickTarget) || chosen.role,
    tag: clickTarget.tagName.toLowerCase(),
    clientX: x,
    clientY: y,
    stateSignature: stateSignature(clickTarget),
    targetStateChanged: false,
    stateEvidence: '',
    evidence: uniqueExactTitleTarget === element ? 'unique-exact-title->ant-tree-wrapper' : 'semantic-score',
  }
  if (mode === 'measure') return descriptor

  const beforeState = descriptor.stateSignature
  clickTarget.focus?.({ preventScroll: true })
  if (typeof PointerEvent !== 'undefined') {
    for (const type of ['pointerover', 'pointermove', 'pointerdown', 'pointerup']) clickTarget.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 }))
  }
  for (const type of ['mouseover', 'mousemove', 'mousedown', 'mouseup']) clickTarget.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 }))
  if (typeof clickTarget.click === 'function') clickTarget.click()
  else clickTarget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 }))
  await new Promise(resolve => setTimeout(resolve, 260))
  const targetStateChanged = !clickTarget.isConnected || stateSignature(clickTarget) !== beforeState
  const stateEvidence = !clickTarget.isConnected
    ? 'semantic click target detached/re-rendered'
    : targetStateChanged
      ? 'semantic click target DOM state changed'
      : ''
  // Persist the actual interactive ancestor for ordinary cards/headings. Ant
  // tree leaves remain the exception because replay deliberately re-promotes
  // their stable titled leaf to the framework wrapper.
  return {
    ...descriptor,
    targetStateChanged,
    stateEvidence,
  }
}
