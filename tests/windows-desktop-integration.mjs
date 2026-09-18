import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { WindowsDesktopDriver } from '../desktop-runtime/windows-driver.js'

if (process.platform !== 'win32') {
  console.log('windows-desktop-integration: skipped (non-Windows)')
  process.exit(0)
}

const TITLE = 'DSH Patrol Desktop Smoke'
const TEXT = 'DSH Patrol UIA integration'
const HOTKEY_TEXT = 'window-targeted input'
const PASTE_SUFFIX = ' + paste'
const fixture = fileURLToPath(new URL('./windows-desktop-fixture.ps1', import.meta.url))
const powershell = process.env.DSH_PATROL_POWERSHELL || 'powershell.exe'
const child = spawn(powershell, [
  '-NoProfile',
  '-STA',
  '-ExecutionPolicy', 'Bypass',
  '-File', fixture,
  '-Title', TITLE,
], {
  windowsHide: false,
  stdio: ['ignore', 'pipe', 'pipe'],
})

let stderr = ''
child.stderr.on('data', chunk => { stderr += String(chunk) })

const driver = new WindowsDesktopDriver({ commandTimeoutMs: 20000, powerShell: powershell })

try {
  const window = await waitForWindow(driver, TITLE, 15000)
  console.log(`fixture window: ${window.processName} / ${window.title}`)

  const snapshot = await driver.run('snapshot', {
    title: TITLE,
    maxElements: 200,
  })
  const input = snapshot.elements.find(element =>
    element.automationId === 'SmokeInput'
    || element.name === 'Smoke Input'
    || (element.controlType === 'Edit' && element.className))
  if (!input) {
    throw new Error(`fixture input not present in UIA snapshot: ${JSON.stringify(snapshot.elements.slice(0, 20))}`)
  }
  if (input.isPassword !== false) {
    throw new Error(`fixture input should be non-password: ${JSON.stringify(input)}`)
  }

  const selector = input.automationId
    ? { automationId: input.automationId }
    : input.name
      ? { name: input.name }
      : { controlType: input.controlType, className: input.className }

  const typed = await driver.run('type-target', {
    title: TITLE,
    ...selector,
    text: TEXT,
    clear: true,
  })
  if (!typed.ok || typed.chars !== TEXT.length) {
    throw new Error(`type-target did not report expected result: ${JSON.stringify(typed)}`)
  }

  const ready = await driver.waitForTarget({
    source: 'uia',
    title: TITLE,
    ...selector,
    value: TEXT,
    match: 'exact',
    requireUnique: true,
    timeoutMs: 5000,
    pollMs: 200,
  })
  if (ready.method !== 'uia' || ready.matchCount !== 1) {
    throw new Error(`value-aware semantic wait failed: ${JSON.stringify(ready)}`)
  }

  const selected = await driver.run('hotkey', {
    title: TITLE,
    combo: 'Ctrl+A',
  })
  if (selected.window?.title !== TITLE) {
    throw new Error(`targeted hotkey did not activate fixture window: ${JSON.stringify(selected)}`)
  }

  const relativeTyped = await driver.run('type-text', {
    title: TITLE,
    text: HOTKEY_TEXT,
    clear: false,
  })
  if (relativeTyped.window?.title !== TITLE || relativeTyped.chars !== HOTKEY_TEXT.length) {
    throw new Error(`targeted type-text did not report fixture window: ${JSON.stringify(relativeTyped)}`)
  }
  await driver.waitForTarget({
    source: 'uia',
    title: TITLE,
    ...selector,
    value: HOTKEY_TEXT,
    match: 'exact',
    requireUnique: true,
    timeoutMs: 5000,
    pollMs: 200,
  })

  await driver.run('set-clipboard-text', { text: PASTE_SUFFIX })
  const pasted = await driver.run('paste-target', { title: TITLE, ...selector })
  if (pasted.window?.title !== TITLE || !pasted.focusMethod) {
    throw new Error(`atomic target paste did not focus fixture input: ${JSON.stringify(pasted)}`)
  }
  const pastedText = `${HOTKEY_TEXT}${PASTE_SUFFIX}`
  await driver.waitForTarget({
    source: 'uia',
    title: TITLE,
    ...selector,
    value: pastedText,
    match: 'exact',
    requireUnique: true,
    timeoutMs: 5000,
    pollMs: 200,
  })

  const pressed = await driver.run('press-target', { title: TITLE, ...selector, key: 'Enter' })
  if (pressed.window?.title !== TITLE || !pressed.focusMethod) {
    throw new Error(`atomic target key press did not focus fixture input: ${JSON.stringify(pressed)}`)
  }
  await driver.waitForTarget({
    source: 'uia',
    title: TITLE,
    name: `applied:${pastedText}`,
    match: 'exact',
    requireUnique: true,
    timeoutMs: 5000,
    pollMs: 200,
  })

  await driver.run('type-target', {
    title: TITLE,
    ...selector,
    text: TEXT,
    clear: true,
  })

  const clicked = await driver.run('click-target', {
    title: TITLE,
    name: 'Apply Smoke',
  })
  if (!clicked.ok) throw new Error(`click-target failed: ${JSON.stringify(clicked)}`)

  const applied = await driver.waitForTarget({
    source: 'uia',
    title: TITLE,
    name: `applied:${TEXT}`,
    match: 'exact',
    requireUnique: true,
    timeoutMs: 5000,
    pollMs: 200,
  })
  if (applied.method !== 'uia' || applied.matchCount !== 1) {
    throw new Error(`post-click UIA state wait failed: ${JSON.stringify(applied)}`)
  }

  const shot = await driver.screenshot({ title: TITLE, fileName: 'windows-uia-integration' })
  await access(shot.path)
  if (!(shot.width > 0 && shot.height > 0)) {
    throw new Error(`desktop screenshot returned invalid bounds: ${JSON.stringify(shot)}`)
  }

  console.log(JSON.stringify({
    ok: true,
    selector,
    typedChars: typed.chars,
    semanticWait: ready.method,
    clickMethod: clicked.method,
    postClickWait: applied.method,
    targetedKeyboard: {
      hotkeyWindow: selected.window?.title,
      typeTextWindow: relativeTyped.window?.title,
      pasteTargetWindow: pasted.window?.title,
      pasteTargetFocus: pasted.focusMethod,
      pressTargetWindow: pressed.window?.title,
      pressTargetFocus: pressed.focusMethod,
    },
    screenshot: { width: shot.width, height: shot.height },
  }, null, 2))
} finally {
  if (!child.killed) child.kill()
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 1500)),
  ])
  if (child.exitCode === null && !child.killed) child.kill('SIGKILL')
  if (stderr.trim()) console.error(stderr.trim())
}

async function waitForWindow(driver, title, timeoutMs) {
  const started = Date.now()
  let last = []
  while (Date.now() - started < timeoutMs) {
    const result = await driver.run('list-windows', {})
    last = Array.isArray(result.windows) ? result.windows : []
    const match = last.find(window => window.title === title)
    if (match) return match
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`fixture window did not appear; windows=${JSON.stringify(last.slice(0, 12))}`)
}
