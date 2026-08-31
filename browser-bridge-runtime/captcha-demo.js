import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const runtimeDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = dirname(runtimeDir)
const solverScript = join(runtimeDir, 'captcha-demo-solver.py')

export async function trySolveOwnedSiteChallenge(bridge, tabId, classified, options = {}) {
  if (!classified || typeof classified !== 'object') return { attempted: false }
  if (!supportsDemoSolve(classified.kind, classified.subtype)) return { attempted: false }

  let info
  try {
    info = await bridge.request('captchaDemoInfo', { tabId }, options)
  } catch {
    return { attempted: false }
  }
  if (!info || typeof info !== 'object' || info.ok === false) return { attempted: false }
  if (info.available !== true) return { attempted: false }

  if (classified.kind === 'captcha' && classified.subtype === 'click-sequence') {
    return await tryClickSequence(bridge, tabId, options)
  }
  if (classified.kind === 'slider' && classified.subtype === 'slider-puzzle') {
    return await trySliderPuzzle(bridge, tabId, options)
  }
  return { attempted: false }
}

export function supportsDemoSolve(kind, subtype) {
  return (kind === 'captcha' && subtype === 'click-sequence')
    || (kind === 'slider' && subtype === 'slider-puzzle')
}

async function tryClickSequence(bridge, tabId, options) {
  try {
    const capture = await bridge.request('captureCaptchaDemo', { tabId, kind: 'click-sequence' }, options)
    if (!authorizedCapture(capture)) return { attempted: true, completed: false, strategy: 'ddddocr-click-sequence-demo' }
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

async function trySliderPuzzle(bridge, tabId, options) {
  try {
    const capture = await bridge.request('captureCaptchaDemo', { tabId, kind: 'slider-puzzle' }, options)
    if (!authorizedCapture(capture)) return { attempted: true, completed: false, strategy: 'ddddocr-slider-demo' }
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

function authorizedCapture(capture) {
  return !!capture
    && typeof capture === 'object'
    && capture.ok !== false
    && capture.available === true
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
