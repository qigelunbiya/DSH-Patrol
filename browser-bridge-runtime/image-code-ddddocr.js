import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { captchaDemoPythonPath } from './captcha-demo.js'

const runtimeDir = dirname(fileURLToPath(import.meta.url))
const solverScript = join(runtimeDir, 'captcha-demo-solver.py')

/**
 * ddddocr is run over a deterministic preprocessing ensemble by the Python
 * helper. The helper already reports up to four distinct candidates with how
 * many image variants supported each one. A single high-confidence glyph
 * confusion (for example 4/A or 7/T) used to win even when most variants agreed
 * on an all-letter answer. Rank the returned candidates as an ensemble before
 * the JS confidence gate sees them.
 *
 * The ranker never blindly converts characters. It only prefers a length and
 * character class when the weighted ensemble itself has a strong majority, so
 * genuine numeric or mixed CAPTCHAs remain valid.
 */
export function selectConsensusDdddocrCandidate(result) {
  const candidates = Array.isArray(result?.candidates)
    ? result.candidates.map(normalizeCandidate).filter(Boolean)
    : []
  if (candidates.length === 0) return undefined

  const lengthWeights = new Map()
  let totalWeight = 0
  for (const candidate of candidates) {
    const weight = candidateWeight(candidate)
    totalWeight += weight
    lengthWeights.set(candidate.text.length, (lengthWeights.get(candidate.text.length) || 0) + weight)
  }
  const lengths = [...lengthWeights.entries()].sort((left, right) => right[1] - left[1])
  const dominantLength = lengths[0]
  const secondLengthWeight = lengths[1]?.[1] || 0
  const lengthHasMajority = dominantLength !== undefined
    && (dominantLength[1] >= totalWeight * 0.55 || dominantLength[1] >= secondLengthWeight * 1.5)
  const lengthFiltered = lengthHasMajority
    ? candidates.filter(candidate => candidate.text.length === dominantLength[0])
    : candidates

  const classWeights = new Map([['alpha', 0], ['digits', 0], ['mixed', 0]])
  for (const candidate of lengthFiltered) {
    const kind = candidateClass(candidate.text)
    classWeights.set(kind, (classWeights.get(kind) || 0) + candidateWeight(candidate))
  }
  const classes = [...classWeights.entries()].sort((left, right) => right[1] - left[1])
  const dominantClass = classes[0]
  const runnerUpClassWeight = classes[1]?.[1] || 0
  const classHasMajority = dominantClass !== undefined
    && dominantClass[1] > 0
    && dominantClass[1] >= runnerUpClassWeight * 1.8
  const classFiltered = classHasMajority
    ? lengthFiltered.filter(candidate => candidateClass(candidate.text) === dominantClass[0])
    : lengthFiltered

  return classFiltered.sort(compareCandidates)[0] || lengthFiltered.sort(compareCandidates)[0] || candidates.sort(compareCandidates)[0]
}

function normalizeCandidate(value) {
  if (!value || typeof value !== 'object') return undefined
  const text = String(value.text || '').replace(/[^A-Za-z0-9]/g, '')
  if (text.length < 2 || text.length > 12) return undefined
  const confidence = clamp01(value.confidence)
  const support = Number.isFinite(Number(value.support)) ? Math.max(1, Math.min(32, Number(value.support))) : 1
  return {
    ...value,
    text,
    confidence,
    support,
  }
}

function candidateClass(text) {
  if (/^[A-Za-z]+$/.test(text)) return 'alpha'
  if (/^[0-9]+$/.test(text)) return 'digits'
  return 'mixed'
}

function candidateWeight(candidate) {
  // Support from correlated preprocessing variants should matter, but not linearly
  // enough that ten nearly-identical threshold images overwhelm OCR confidence.
  return Math.max(0.05, candidate.confidence) * (1 + Math.log2(Math.max(1, candidate.support)))
}

function compareCandidates(left, right) {
  const scoreLeft = left.confidence + Math.min(0.12, Math.log2(Math.max(1, left.support)) * 0.035)
  const scoreRight = right.confidence + Math.min(0.12, Math.log2(Math.max(1, right.support)) * 0.035)
  return scoreRight - scoreLeft || right.support - left.support || left.text.localeCompare(right.text)
}

function clamp01(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 0
  return Math.max(0, Math.min(1, parsed))
}

export async function recognizeImageCodeWithDdddocr(dataUrl, options = {}) {
  const python = captchaDemoPythonPath()
  if (!python || !existsSync(python) || !existsSync(solverScript)) {
    return { ok: false, error: 'ddddocr runtime is not installed' }
  }
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    return { ok: false, error: 'image-code capture is missing' }
  }

  const timeoutMs = Math.max(1000, Math.min(Number(options.timeoutMs) || 30000, 45000))
  return await new Promise(resolve => {
    const child = spawn(python, [solverScript], {
      cwd: dirname(runtimeDir),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = value => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      finish({ ok: false, error: 'ddddocr image-code recognition timed out' })
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      if (stdout.length < 1024 * 1024) stdout += chunk
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => {
      if (stderr.length < 64 * 1024) stderr += chunk
    })
    child.on('error', error => finish({ ok: false, error: error.message }))
    child.on('close', () => {
      if (settled) return
      try {
        const parsed = JSON.parse(stdout.trim() || '{}')
        if (!parsed || typeof parsed !== 'object') {
          finish({ ok: false, error: stderr.trim() || 'invalid ddddocr result' })
          return
        }
        const consensus = parsed.ok === true ? selectConsensusDdddocrCandidate(parsed) : undefined
        finish(consensus === undefined
          ? parsed
          : {
              ...parsed,
              text: consensus.text,
              confidence: consensus.confidence,
              rawConfidence: consensus.rawConfidence ?? consensus.confidence,
              meanConfidence: consensus.meanConfidence ?? consensus.confidence,
              support: consensus.support,
              variant: consensus.variant ?? parsed.variant,
              variants: consensus.variants ?? parsed.variants,
              ensembleSelected: true,
              ensembleClass: candidateClass(consensus.text),
              ensembleLength: consensus.text.length,
            })
      } catch {
        finish({ ok: false, error: stderr.trim() || 'invalid ddddocr result' })
      }
    })
    options.signal?.addEventListener?.('abort', () => {
      try { child.kill() } catch {}
      finish({ ok: false, error: 'ddddocr image-code recognition aborted' })
    }, { once: true })
    child.stdin.end(JSON.stringify({ operation: 'image-code', image: dataUrl }))
  })
}
