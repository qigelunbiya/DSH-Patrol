import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { captchaDemoPythonPath } from './captcha-demo.js'

const runtimeDir = dirname(fileURLToPath(import.meta.url))
const decoderScript = join(runtimeDir, 'qr-decode.py')

export async function decodeQrImageDataUrl(dataUrl, options = {}) {
  const python = captchaDemoPythonPath()
  if (!python || !existsSync(python) || !existsSync(decoderScript)) {
    return { ok: false, error: 'Patrol local QR decoder is not installed; rerun scripts/install-local.ps1' }
  }
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    return { ok: false, error: 'QR image is missing or invalid' }
  }

  const timeoutMs = Math.max(1000, Math.min(Number(options.timeoutMs) || 30000, 45000))
  return await new Promise(resolve => {
    const child = spawn(python, [decoderScript], {
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
      finish({ ok: false, error: 'QR image decoding timed out' })
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      if (stdout.length < 2 * 1024 * 1024) stdout += chunk
    })
    child.stderr.on('data', chunk => {
      if (stderr.length < 64 * 1024) stderr += chunk
    })
    child.on('error', error => finish({ ok: false, error: error.message }))
    child.on('close', () => {
      if (settled) return
      try {
        const parsed = JSON.parse(stdout.trim() || '{}')
        if (parsed?.ok === true && Array.isArray(parsed.values)) {
          finish({ ok: true, values: parsed.values.map(value => String(value || '')).filter(Boolean) })
          return
        }
        finish({ ok: false, error: String(parsed?.error || stderr.trim() || 'QR image decoding failed') })
      } catch {
        finish({ ok: false, error: stderr.trim() || 'QR decoder returned invalid output' })
      }
    })
    options.signal?.addEventListener?.('abort', () => {
      try { child.kill() } catch {}
      finish({ ok: false, error: 'QR image decoding aborted' })
    }, { once: true })
    child.stdin.end(JSON.stringify({ image: dataUrl }))
  })
}
