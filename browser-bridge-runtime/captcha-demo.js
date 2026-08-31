import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  captchaModeAllowsWeakUnmarkedAutomation,
  currentCaptchaMode,
} from './captcha-mode.js'

const runtimeDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = dirname(runtimeDir)
const solverScript = join(runtimeDir, 'captcha-demo-solver.py')
const DEMO_KINDS = new Set(['click-sequence', 'slider-puzzle'])

export async function probeOwnedSiteChallenge(bridge, tabId, options = {}) {
  try {
    const info = await bridge.request('captchaDemoInfo', { tabId }, options)
    if (!info || typeof info !== 'object' || info.ok === false) return emptyProbe()
    const kinds = Array.isArray(info.kinds)
      ? [...new Set(info.kinds.filter(kind => DEMO_KINDS.has(kind)))]
      : []
    const documentKey = typeof info.documentKey === 'string' ? info.documentKey : ''
    const origin = typeof info.origin === 'string' ? info.origin : ''
    const challengeKeys = {}
    const sources = {}
    for (const kind of kinds) {
      const key = info.challengeKeys && typeof info.challengeKeys[kind] === 'string'
        ? info.challengeKeys[kind]
        : ''
      if (key) challengeKeys[kind] = key
      const source = info.sources && info.sources[kind] === 'weak' ? 'weak' : 'explicit'
      sources[kind] = source
    }
    return {
      available: info.available === true && kinds.length > 0 && documentKey.length > 0,
      kinds,
      documentKey,
      origin,
      challengeKeys,
      sources,
    }
  } catch {
    return emptyProbe()
  }
}

export async function trySolveOwnedSiteChallenge(bridge, tabId, classified, options = {}) {
  if (!classified || typeof classified !== 'object') return { attempted: false, visibleKinds: [] }

  const info = await probeOwnedSiteChallenge(bridge, tabId, options)
  const mode = currentCaptchaMode()
  const selected = selectDemoChallenge(classified, info, mode)
  if (!selected) return { attempted: false, visibleKinds: info.kinds }
  const challengeKey = info.challengeKeys?.[selected.subtype]
  if (typeof challengeKey !== 'string' || challengeKey.length === 0) {
    return { attempted: false, visibleKinds: info.kinds }
  }

  let result
  if (selected.subtype === 'click-sequence') {
    result = await tryClickSequence(bridge, tabId, info.documentKey, challengeKey, options)
  } else if (selected.subtype === 'slider-puzzle') {
    result = await trySliderPuzzle(bridge, tabId, info.documentKey, challengeKey, options)
  } else {
    return { attempted: false, visibleKinds: info.kinds }
  }

  return {
    ...result,
    visibleKinds: info.kinds,
    observedKind: selected.kind,
    observedSubtype: selected.subtype,
  }
}

export function selectDemoChallenge(classified, info, mode = currentCaptchaMode()) {
  if (!info?.available || !Array.isArray(info.kinds) || !info.documentKey) return null
  if (isProtectedChallenge(classified)) return null

  const exactSubtype = supportsDemoSolve(classified?.kind, classified?.subtype)
    ? classified.subtype
    : ''
  if (exactSubtype && info.kinds.includes(exactSubtype)) {
    if (!sourceAllowed(demoSource(info, exactSubtype), mode)) return null
    return demoDescriptor(exactSubtype)
  }

  const weakClassification = classified?.kind === 'none'
    || (classified?.kind === 'captcha' && classified?.subtype === 'generic-captcha')
    || (classified?.kind === 'slider' && classified?.subtype === 'slider')
  if (!weakClassification) return null

  const allowedKinds = info.kinds.filter(kind => sourceAllowed(demoSource(info, kind), mode))
  if (allowedKinds.length !== 1) return null
  return demoDescriptor(allowedKinds[0])
}

export function supportsDemoSolve(kind, subtype) {
  return (kind === 'captcha' && subtype === 'click-sequence')
    || (kind === 'slider' && subtype === 'slider-puzzle')
}

export function authorizedCapture(capture, documentKey, challengeKey, kind) {
  return !!capture
    && typeof capture === 'object'
    && capture.ok !== false
    && capture.available === true
    && capture.documentKey === documentKey
    && capture.challengeKey === challengeKey
    && capture.kind === kind
}

function sourceAllowed(source, mode) {
  if (source === 'explicit') return mode?.explicitDemoAutomation !== false
  return captchaModeAllowsWeakUnmarkedAutomation(mode)
}

function demoSource(info, kind) {
  return info?.sources?.[kind] === 'weak' ? 'weak' : 'explicit'
}

function demoDescriptor(subtype) {
  if (subtype === 'click-sequence') {
    return { kind: 'captcha', subtype, strategy: 'ddddocr-click-sequence-demo' }
  }
  if (subtype === 'slider-puzzle') {
    return { kind: 'slider', subtype, strategy: 'ddddocr-slider-demo' }
  }
  return null
}

function isProtectedChallenge(classified) {
  if (!classified || typeof classified !== 'object') return true
  if (classified.kind === 'otp' || classified.kind === 'approval' || classified.kind === 'unknown') return true
  if (classified.kind === 'captcha' && ['image-code', 'third-party', 'rotate'].includes(classified.subtype)) return true
  return false
}

function emptyProbe() {
  return { available: false, kinds: [], documentKey: '', origin: '', challengeKeys: {}, sources: {} }
}

async function tryClickSequence(bridge, tabId, documentKey, challengeKey, options) {
  try {
    const capture = await bridge.request('captureCaptchaDemo', {
      tabId,
      kind: 'click-sequence',
      documentKey,
      challengeKey,
    }, options)
    if (!authorizedCapture(capture, documentKey, challengeKey, 'click-sequence')) {
      return { attempted: true, completed: false, strategy: 'ddddocr-click-sequence-demo' }
    }
    if (typeof capture.targetText !== 'string' || capture.targetText.trim() === '') {
      return { attempted: true, completed: false, strategy: 'ddddocr-click-sequence-demo' }
    }
    const solved = await runSolver({
      operation: 'click-sequence',
      image: capture.imageDataUrl,
      targetText: capture.targetText,
    }, options)
    if (!solved.ok || !Array.isArray(solved.points) || solved.points.length === 0) {
      return { attempted: true, completed: false, strategy: 'ddddocr-click-sequence-demo' }
    }
    const result = await bridge.request('captchaDemoClickPoints', {
      tabId,
      kind: 'click-sequence',
      documentKey,
      challengeKey,
      selector: capture.imageSelector,
      points: solved.points,
    }, options)
    return {
      attempted: true,
      completed: !!result?.ok,
      strategy: 'ddddocr-click-sequence-demo',
    }
  } catch {
    return { attempted: true, completed: false, strategy: 'ddddocr-click-sequence-demo' }
  }
}

async function trySliderPuzzle(bridge, tabId, documentKey, challengeKey, options) {
  try {
    const capture = await bridge.request('captureCaptchaDemo', {
      tabId,
      kind: 'slider-puzzle',
      documentKey,
      challengeKey,
    }, options)
    if (!authorizedCapture(capture, documentKey, challengeKey, 'slider-puzzle')) {
      return { attempted: true, completed: false, strategy: 'ddddocr-slider-demo' }
    }
    if (typeof capture.pieceDataUrl !== 'string' || typeof capture.backgroundDataUrl !== 'string') {
      return { attempted: true, completed: false, strategy: 'ddddocr-slider-demo' }
    }
    const solved = await runSolver({
      operation: 'slider-puzzle',
      pieceImage: capture.pieceDataUrl,
      backgroundImage: capture.backgroundDataUrl,
    }, options)
    if (!solved.ok || !Number.isFinite(solved.normalizedX)) {
      return { attempted: true, completed: false, strategy: 'ddddocr-slider-demo' }
    }
    const result = await bridge.request('captchaDemoDrag', {
      tabId,
      kind: 'slider-puzzle',
      documentKey,
      challengeKey,
      handleSelector: capture.handleSelector,
      backgroundSelector: capture.backgroundSelector,
      normalizedX: solved.normalizedX,
    }, options)
    return {
      attempted: true,
      completed: !!result?.ok,
      strategy: 'ddddocr-slider-demo',
    }
  } catch {
    return { attempted: true, completed: false, strategy: 'ddddocr-slider-demo' }
  }
}

export function captchaDemoPythonPath() {
  const configured = process.env.DSH_PATROL_CAPTCHA_DEMO_PYTHON
  if (configured && existsSync(configured)) return configured
  const windows = join(projectRoot, '.captcha-demo-venv', 'Scripts', 'python.exe')
  const unix = join(projectRoot, '.captcha-demo-venv', 'bin', 'python')
  if (existsSync(windows)) return windows
  if (existsSync(unix)) return unix
  return ''
}

async function runSolver(payload, options = {}) {
  const python = captchaDemoPythonPath()
  if (!python || !existsSync(solverScript)) return { ok: false, error: 'captcha demo solver is not installed' }
  const timeoutMs = Math.max(1000, Math.min(Number(options.timeoutMs) || 45000, 60000))
  return await new Promise(resolve => {
    const child = spawn(python, [solverScript], {
      cwd: projectRoot,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      resolve({ ok: false, error: 'captcha demo solver timed out' })
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      if (stdout.length < 1024 * 1024) stdout += chunk
    })
    child.stderr.on('data', chunk => {
      if (stderr.length < 64 * 1024) stderr += chunk
    })
    child.on('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, error: error.message })
    })
    child.on('close', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        const parsed = JSON.parse(stdout.trim() || '{}')
        resolve(parsed && typeof parsed === 'object' ? parsed : { ok: false, error: 'invalid solver result' })
      } catch {
        resolve({ ok: false, error: stderr.trim() || 'invalid solver result' })
      }
    })
    child.stdin.end(JSON.stringify(payload))
  })
}
