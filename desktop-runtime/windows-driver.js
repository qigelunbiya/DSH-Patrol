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
      return { ok: true, status: 'unavailable', text: '', screenshotPath: shot.path }
    }
    const locale = Intl.DateTimeFormat().resolvedOptions().locale || 'zh-CN'
    const languages = [...new Set([locale, 'zh-CN', 'en-US'])]
    const result = await recognize(image, OcrAccuracy.Accurate, languages, exec?.signal)
    const text = normalizeOcr(result?.text)
    return {
      ok: true,
      status: text ? 'recognized' : 'empty',
      text,
      screenshotPath: shot.path,
      width: shot.width,
      height: shot.height,
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

function normalizeOcr(value) {
  const text = String(value ?? '')
    .replace(/\u0000/g, ' ')
    .split(/\r?\n/)
    .map(line => line.replace(/[\t ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
  return text.length <= MAX_OCR_CHARS ? text : `${text.slice(0, MAX_OCR_CHARS)}…`
}
