import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { captchaDemoPythonPath } from './captcha-demo.js'

const runtimeDir = dirname(fileURLToPath(import.meta.url))
const solverScript = join(runtimeDir, 'captcha-demo-solver.py')

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
    child.stderr.on('data', chunk => {
      if (stderr.length < 64 * 1024) stderr += chunk
    })
    child.on('error', error => finish({ ok: false, error: error.message }))
    child.on('close', () => {
      if (settled) return
      try {
        const parsed = JSON.parse(stdout.trim() || '{}')
        finish(parsed && typeof parsed === 'object'
          ? parsed
          : { ok: false, error: stderr.trim() || 'invalid ddddocr result' })
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
