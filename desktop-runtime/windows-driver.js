import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'

const execFileAsync = promisify(execFile)
const SCRIPT_PATH = fileURLToPath(new URL('./windows-desktop.ps1', import.meta.url))
const BUNDLED_GUIDES = fileURLToPath(new URL('../desktop-knowledge/', import.meta.url))
const MAX_STDOUT = 4 * 1024 * 1024
const MAX_GUIDE_CHARS = 30000
const MAX_OCR_CHARS = 12000

export class WindowsDesktopDriver {
  constructor(options = {}) {
    this.logger = options.logger
    this.commandTimeoutMs = options.commandTimeoutMs ?? 30000
    this.powerShell = options.powerShell || process.env.DSH_PATROL_POWERSHELL || 'powershell.exe'
  }

  get supported() {
    return process.platform === 'win32'
  }

  status() {
    return {
      ok: true,
      platform: process.platform,
      supported: this.supported,
      backend: this.supported ? 'windows-uia+powershell' : 'unsupported',
      permissionMode: 'unrestricted',
      strategy: ['uia', 'keyboard', 'ocr', 'coordinates'],
    }
  }

  async run(action, args = {}, exec) {
    if (!this.supported) {
      throw new Error(`Desktop Automation currently requires Windows; current platform=${process.platform}`)
    }
    const payload = Buffer.from(JSON.stringify(args), 'utf8').toString('base64')
    let stdout
    let stderr
    try {
      const result = await execFileAsync(this.powerShell, [
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-ExecutionPolicy', 'Bypass',
        '-File', SCRIPT_PATH,
        '-Action', action,
        '-Payload', payload,
      ], {
        windowsHide: true,
        timeout: this.commandTimeoutMs,
        maxBuffer: MAX_STDOUT,
        encoding: 'utf8',
        signal: exec?.signal,
      })
      stdout = result.stdout
      stderr = result.stderr
    } catch (error) {
      stdout = error?.stdout
      stderr = error?.stderr
      const parsed = parseLastJson(stdout)
      if (parsed?.error) throw new Error(parsed.error)
      throw new Error(cleanPowerShellError(error, stderr))
    }
    const parsed = parseLastJson(stdout)
    if (!parsed || parsed.ok !== true) {
      throw new Error(parsed?.error || `desktop action ${action} returned invalid output`)
    }
    return parsed
  }

  async screenshot(args = {}, exec) {
    const path = await this.nextScreenshotPath(exec, args.fileName)
    return await this.run('screenshot', { ...args, path }, exec)
  }

  async ocr(args = {}, exec) {
    const shot = await this.screenshot(args, exec)
    const image = await readFile(shot.path)
    const systemOcr = await import('@napi-rs/system-ocr')
    const recognize = systemOcr.recognize ?? systemOcr.default?.recognize
    const OcrAccuracy = systemOcr.OcrAccuracy ?? systemOcr.default?.OcrAccuracy
    if (typeof recognize !== 'function' || !OcrAccuracy) {
      return {
        ok: true,
        status: 'unavailable',
        text: '',
        lines: [],
        screenshotPath: shot.path,
        screenshotBounds: screenshotBounds(shot),
      }
    }

    const locale = Intl.DateTimeFormat().resolvedOptions().locale || 'zh-CN'
    const requested = Array.isArray(args.languages)
      ? args.languages.map(value => String(value ?? '').trim()).filter(Boolean)
      : []
    const languages = [...new Set([...requested, locale, 'zh-CN', 'en-US'])].slice(0, 4)
    const observations = []
    const failures = []
    for (const language of languages) {
      try {
        // system-ocr on Windows only consumes the first preferred language,
        // so run bounded passes and merge the line geometry. This matters for
        // Chinese apps such as WeChat on machines whose Node locale is en-US.
        const result = await recognize(image, OcrAccuracy.Accurate, [language], exec?.signal)
        observations.push({ language, result })
      } catch (error) {
        failures.push({ language, error: String(error?.message ?? error) })
      }
    }

    const lines = normalizeOcrObservations(observations, shot)
    const lineText = lines.map(line => line.text).join('\n')
    const fallbackText = observations.map(item => item?.result?.text ?? '').join('\n')
    const text = normalizeOcr(lineText || fallbackText)
    return {
      ok: true,
      status: text ? 'recognized' : observations.length > 0 ? 'empty' : 'unavailable',
      text,
      lines,
      languagesTried: languages,
      languagesSucceeded: observations.map(item => item.language),
      ...(failures.length === 0 ? {} : { languageErrors: failures }),
      screenshotPath: shot.path,
      screenshotBounds: screenshotBounds(shot),
      x: shot.x,
      y: shot.y,
      width: shot.width,
      height: shot.height,
    }
  }

  async clickOcrText(args = {}, exec) {
    const text = String(args.text ?? '').trim()
    if (!text) throw new Error('desktop_click_ocr_text requires text')
    const match = args.match === 'contains' ? 'contains' : 'exact'
    const caseSensitive = args.caseSensitive === true
    const windowArgs = Object.fromEntries(
      ['processName', 'title', 'titleContains']
        .filter(key => typeof args[key] === 'string' && args[key].trim() !== '')
        .map(key => [key, args[key]]),
    )
    if (Object.keys(windowArgs).length > 0) {
      await this.run('activate-window', windowArgs, exec)
    }
    const ocr = await this.ocr(args, exec)
    const normalize = value => caseSensitive ? String(value ?? '') : String(value ?? '').toLocaleLowerCase()
    const needle = normalize(text)
    const candidates = (ocr.lines ?? []).filter(line => {
      const haystack = normalize(line.text)
      return match === 'contains' ? haystack.includes(needle) : haystack === needle
    })

    let target
    if (args.index !== undefined) {
      const index = Number(args.index)
      if (!Number.isInteger(index) || index < 0 || index >= candidates.length) {
        throw new Error(`desktop OCR target index ${args.index} is out of range; matches=${candidates.length}`)
      }
      target = candidates[index]
    } else {
      if (candidates.length === 0) {
        throw new Error(`desktop OCR text target not found: ${JSON.stringify(text)}`)
      }
      if (candidates.length !== 1) {
        const sample = candidates.slice(0, 8).map(item => `${item.text}@(${item.center.x},${item.center.y})`).join(' | ')
        throw new Error(`desktop OCR text target is ambiguous (${candidates.length} matches): ${sample}`)
      }
      target = candidates[0]
    }

    await this.run('click-coordinates', {
      x: target.center.x,
      y: target.center.y,
      button: args.button === 'right' ? 'right' : 'left',
    }, exec)
    return {
      ok: true,
      method: 'ocr-line-center',
      match,
      query: text,
      matchCount: candidates.length,
      target,
      screenshotPath: ocr.screenshotPath,
      screenshotBounds: ocr.screenshotBounds,
      languagesTried: ocr.languagesTried,
    }
  }

  async waitForTarget(args = {}, exec) {
    const source = args.source === 'uia' || args.source === 'ocr' ? args.source : 'auto'
    const timeoutMs = boundedInteger(args.timeoutMs, 10000, 100, 120000)
    const pollMs = boundedInteger(args.pollMs, 300, 100, 5000)
    const requireUnique = args.requireUnique !== false
    const text = String(args.text ?? '').trim()
    const hasUiaSelector = ['name', 'automationId', 'controlType', 'className']
      .some(key => typeof args[key] === 'string' && args[key].trim() !== '')
    if (!hasUiaSelector && !text) {
      throw new Error('desktop_wait_for_target requires text or a UI Automation selector')
    }
    if (source === 'ocr' && !text) {
      throw new Error('desktop_wait_for_target source=ocr requires text')
    }

    const windowArgs = Object.fromEntries(
      ['processName', 'title', 'titleContains']
        .filter(key => typeof args[key] === 'string' && args[key].trim() !== '')
        .map(key => [key, args[key]]),
    )
    const startedAt = Date.now()
    const waitCaptureName = typeof args.fileName === 'string' && args.fileName.trim() !== ''
      ? args.fileName
      : `desktop-wait-${randomUUID().slice(0, 8)}`
    let attempts = 0
    let lastUiaCount = 0
    let lastOcrCount = 0
    let lastError = ''

    while (true) {
      attempts += 1

      if (Object.keys(windowArgs).length > 0) {
        try {
          await this.run('activate-window', windowArgs, exec)
        } catch (error) {
          lastError = `window activation: ${String(error?.message ?? error)}`
        }
      }

      if (source !== 'ocr') {
        try {
          const snapshot = await this.run('snapshot', {
            ...windowArgs,
            maxElements: boundedInteger(args.maxElements, 500, 1, 1000),
            includeOffscreen: false,
          }, exec)
          const uiArgs = {
            ...args,
            ...(typeof args.name === 'string' && args.name.trim() !== '' ? {} : text ? { name: text } : {}),
          }
          const matches = findUiaTargetMatches(snapshot.elements, uiArgs)
          lastUiaCount = matches.length
          if (matches.length > 0 && (!requireUnique || matches.length === 1)) {
            return {
              ok: true,
              method: 'uia',
              attempts,
              elapsedMs: Date.now() - startedAt,
              matchCount: matches.length,
              target: matches[0],
              window: snapshot.window,
            }
          }
        } catch (error) {
          lastError = `UIA: ${String(error?.message ?? error)}`
        }
      }

      if (source !== 'uia' && text) {
        try {
          const ocr = await this.ocr({ ...args, fileName: waitCaptureName }, exec)
          const matches = findOcrTextMatches(ocr.lines, {
            text,
            match: args.match,
            caseSensitive: args.caseSensitive,
          })
          lastOcrCount = matches.length
          if (matches.length > 0 && (!requireUnique || matches.length === 1)) {
            return {
              ok: true,
              method: 'ocr',
              attempts,
              elapsedMs: Date.now() - startedAt,
              matchCount: matches.length,
              target: matches[0],
              screenshotPath: ocr.screenshotPath,
              screenshotBounds: ocr.screenshotBounds,
              languagesTried: ocr.languagesTried,
            }
          }
        } catch (error) {
          lastError = `OCR: ${String(error?.message ?? error)}`
        }
      }

      const elapsedMs = Date.now() - startedAt
      if (elapsedMs >= timeoutMs) {
        const uniqueness = requireUnique ? 'exactly one matching target' : 'at least one matching target'
        const evidence = [
          source === 'ocr' ? '' : `uiaMatches=${lastUiaCount}`,
          source === 'uia' ? '' : `ocrMatches=${lastOcrCount}`,
          lastError,
        ].filter(Boolean).join('; ')
        throw new Error(`desktop_wait_for_target timed out after ${elapsedMs}ms waiting for ${uniqueness}; ${evidence || 'no matching CURRENT evidence'}`)
      }
      await waitWithSignal(Math.min(pollMs, timeoutMs - elapsedMs), exec?.signal)
    }
  }

  async listGuides(exec) {
    const roots = guideRoots(exec)
    const names = new Set()
    const sources = []
    for (const root of roots) {
      try {
        const entries = await readdir(root, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
          names.add(entry.name.slice(0, -3))
        }
        sources.push(root)
      } catch (error) {
        if (error?.code !== 'ENOENT') this.logger?.warn?.(`[dsh-patrol/desktop] guide scan failed for ${root}: ${error?.message ?? error}`)
      }
    }
    return { ok: true, guides: [...names].sort((a, b) => a.localeCompare(b, 'zh-CN')), sources }
  }

  async readGuide(app, exec) {
    const safe = safeGuideName(app)
    const roots = guideRoots(exec)
    for (const root of roots) {
      const path = join(root, `${safe}.md`)
      try {
        const content = await readFile(path, 'utf8')
        return {
          ok: true,
          app: safe,
          path,
          source: root === BUNDLED_GUIDES ? 'bundled' : 'workspace',
          content: content.length <= MAX_GUIDE_CHARS ? content : `${content.slice(0, MAX_GUIDE_CHARS)}\n…[truncated]`,
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
    const available = await this.listGuides(exec)
    throw new Error(`desktop app guide ${JSON.stringify(safe)} not found; available=[${available.guides.join(', ')}]`)
  }

  async nextScreenshotPath(exec, requestedName) {
    const workspace = exec?.agent?.session?.header?.cwd
    const root = workspace
      ? join(resolve(workspace), 'patrol-results', 'desktop-captures')
      : join(tmpdir(), 'dsh-patrol-desktop')
    await mkdir(root, { recursive: true })
    const stem = safeFileStem(requestedName || `desktop-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`)
    return join(root, `${stem}.png`)
  }
}

function guideRoots(exec) {
  const workspace = exec?.agent?.session?.header?.cwd
  return [
    ...(workspace ? [
      join(resolve(workspace), 'patrol-desktop-knowledge'),
      join(resolve(workspace), '.dsh-patrol', 'desktop-knowledge'),
    ] : []),
    BUNDLED_GUIDES,
  ]
}

function safeGuideName(value) {
  const name = String(value ?? '').trim().replace(/\.md$/i, '')
  if (!name || /[\\/:*?"<>|\u0000-\u001f]/.test(name) || name.includes('..')) {
    throw new Error('app guide name must be a simple file stem, for example 微信 or WPS')
  }
  return name
}

function safeFileStem(value) {
  const stem = basename(String(value ?? '').replace(/\.png$/i, ''))
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 96)
  return stem || 'desktop'
}

function parseLastJson(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(lines[index])
      if (value && typeof value === 'object') return value
    } catch {}
  }
  return undefined
}

function cleanPowerShellError(error, stderr) {
  const message = String(error?.message ?? error ?? 'desktop PowerShell action failed')
  const details = String(stderr ?? '').trim()
  return details ? `${message}: ${details.slice(0, 1000)}` : message
}

export function normalizeOcrObservations(observations, shot, maxLines = 240) {
  const out = []
  const width = finiteNumber(shot?.width, 0)
  const height = finiteNumber(shot?.height, 0)
  const originX = finiteNumber(shot?.x, 0)
  const originY = finiteNumber(shot?.y, 0)
  if (width <= 0 || height <= 0) return out

  for (const observation of observations ?? []) {
    const language = String(observation?.language ?? '')
    const lines = Array.isArray(observation?.result?.lines) ? observation.result.lines : []
    for (const raw of lines) {
      const text = normalizeOcrLine(raw?.text)
      const box = raw?.boundingBox
      if (!text || !validNormalizedBox(box)) continue
      const x = Math.round(originX + box.x * width)
      const y = Math.round(originY + box.y * height)
      const lineWidth = Math.max(1, Math.round(box.width * width))
      const lineHeight = Math.max(1, Math.round(box.height * height))
      const center = {
        x: Math.round(x + lineWidth / 2),
        y: Math.round(y + lineHeight / 2),
      }
      if (out.some(existing =>
        existing.text.toLocaleLowerCase() === text.toLocaleLowerCase()
        && Math.abs(existing.center.x - center.x) <= 8
        && Math.abs(existing.center.y - center.y) <= 8)) {
        continue
      }
      out.push({
        text,
        confidence: finiteNumber(raw?.confidence, 0),
        language,
        rect: { x, y, width: lineWidth, height: lineHeight },
        center,
      })
      if (out.length >= maxLines) return out
    }
  }
  return out
}

export function findUiaTargetMatches(elements, args = {}) {
  const rows = Array.isArray(elements) ? elements : []
  const match = args.match === 'contains' ? 'contains' : 'exact'
  const caseSensitive = args.caseSensitive === true
  const requestedName = String(args.name ?? '').trim()
  const requestedAutomationId = String(args.automationId ?? '').trim()
  const requestedControlType = String(args.controlType ?? '').trim()
  const requestedClassName = String(args.className ?? '').trim()
  const normalize = value => caseSensitive ? String(value ?? '') : String(value ?? '').toLocaleLowerCase()
  const compare = (actual, expected, mode = 'exact') => {
    if (!expected) return true
    const left = normalize(actual)
    const right = normalize(expected)
    return mode === 'contains' ? left.includes(right) : left === right
  }
  return rows.filter(row =>
    compare(row?.name, requestedName, match)
    && compare(row?.automationId, requestedAutomationId)
    && compare(row?.controlType, requestedControlType)
    && compare(row?.className, requestedClassName))
}

export function findOcrTextMatches(lines, args = {}) {
  const rows = Array.isArray(lines) ? lines : []
  const text = String(args.text ?? '').trim()
  if (!text) return []
  const match = args.match === 'contains' ? 'contains' : 'exact'
  const caseSensitive = args.caseSensitive === true
  const normalize = value => caseSensitive ? String(value ?? '') : String(value ?? '').toLocaleLowerCase()
  const needle = normalize(text)
  return rows.filter(line => {
    const haystack = normalize(line?.text)
    return match === 'contains' ? haystack.includes(needle) : haystack === needle
  })
}

function boundedInteger(value, fallback, min, max) {
  const numeric = Number(value)
  if (!Number.isInteger(numeric)) return fallback
  return Math.min(max, Math.max(min, numeric))
}

async function waitWithSignal(milliseconds, signal) {
  if (milliseconds <= 0) return
  if (signal?.aborted) throw signal.reason ?? new Error('desktop wait aborted')
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, milliseconds)
    const onAbort = () => {
      cleanup()
      reject(signal.reason ?? new Error('desktop wait aborted'))
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

function screenshotBounds(shot) {
  return {
    x: finiteNumber(shot?.x, 0),
    y: finiteNumber(shot?.y, 0),
    width: finiteNumber(shot?.width, 0),
    height: finiteNumber(shot?.height, 0),
  }
}

function validNormalizedBox(box) {
  return box
    && Number.isFinite(box.x)
    && Number.isFinite(box.y)
    && Number.isFinite(box.width)
    && Number.isFinite(box.height)
    && box.width > 0
    && box.height > 0
}

function finiteNumber(value, fallback) {
  return Number.isFinite(value) ? Number(value) : fallback
}

function normalizeOcrLine(value) {
  return String(value ?? '').replace(/\u0000/g, ' ').replace(/[\t ]+/g, ' ').trim()
}

function normalizeOcr(value) {
  const seen = new Set()
  const lines = String(value ?? '')
    .replace(/\u0000/g, ' ')
    .split(/\r?\n/)
    .map(line => line.replace(/[\t ]+/g, ' ').trim())
    .filter(Boolean)
    .filter(line => {
      const key = line.toLocaleLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  const text = lines.join('\n')
  return text.length <= MAX_OCR_CHARS ? text : `${text.slice(0, MAX_OCR_CHARS)}…`
}
