import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const extensionRoot = fileURLToPath(new URL('../browser-extension/', import.meta.url))
const manifest = JSON.parse(readFileSync(join(extensionRoot, 'manifest.json'), 'utf8'))
const entry = readFileSync(join(extensionRoot, 'background-entry.js'), 'utf8')
const registration = readFileSync(join(extensionRoot, 'frame-registration.js'), 'utf8')
const support = readFileSync(join(extensionRoot, 'frame-support.js'), 'utf8')
const content = readFileSync(join(extensionRoot, 'frame-content.js'), 'utf8')

for (const file of ['background-entry.js', 'frame-registration.js', 'frame-support.js', 'frame-content.js']) {
  const result = spawnSync(process.execPath, ['--check', join(extensionRoot, file)], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${file} syntax check failed:\n${result.stderr}`)
}

if (manifest.background?.service_worker !== 'background-entry.js') throw new Error('frame-aware Patrol must use the audited background entrypoint')
if (!manifest.permissions?.includes('webNavigation')) throw new Error('frame-aware Patrol requires webNavigation frame enumeration')
if (!manifest.permissions?.includes('scripting')) throw new Error('frame-aware Patrol requires scripting for dynamic frame-content registration')
if (manifest.content_scripts?.some(item => item.all_frames === true)) throw new Error('legacy Patrol content scripts must remain top-frame-only')

if (!entry.includes("importScripts('background.js')") || !entry.includes("importScripts('frame-registration.js')") || !entry.includes("importScripts('frame-support.js')")) {
  throw new Error('background entrypoint must load legacy bridge, audited registration, then frame routing')
}
if (!registration.includes("js: ['frame-content.js']")) throw new Error('dynamic registration must load only frame-content.js')
if (!registration.includes('allFrames: true')) throw new Error('frame-content registration must explicitly cover nested frames')
if (!registration.includes('matchOriginAsFallback: true')) throw new Error('about/blob/srcdoc descendant frames must inherit eligible creator origins')
if (!registration.includes('persistAcrossSessions: true')) throw new Error('frame-content registration must persist across managed browser restarts')
if (/executeScript\s*\(/.test(registration) || /executeScript\s*\(/.test(support)) throw new Error('Patrol must not repeatedly inject arbitrary frame scripts at command time')

if (/\beval\s*\(/.test(content) || /new\s+Function\s*\(/.test(content)) throw new Error('frame content bridge must not evaluate page code')
if (/\bfetch\s*\(/.test(content) || /XMLHttpRequest/.test(content)) throw new Error('frame content bridge must not issue page-network requests')
if (/chrome\.cookies|document\.cookie/.test(content)) throw new Error('frame content bridge must not read raw cookies')
if (!content.includes('FRAME_SENSITIVE_INPUT')) throw new Error('frame snapshot credential redaction is missing')
if (!content.includes("cell.getAttribute('title')")) throw new Error('structured grid extraction must preserve full title-backed cell values')
if (!content.includes("cell.getAttribute('aria-describedby')")) throw new Error('structured grid extraction must resolve jqGrid aria-describedby headers')
if (!content.includes("root.querySelectorAll('table')")) throw new Error('structured table discovery is missing')
if (!content.includes('frameStableSelector(clickable)')) throw new Error('structured table rows must expose safe click selectors')

if (!support.includes('chrome.webNavigation.getAllFrames')) throw new Error('frame routing must enumerate browser frames')
if (!support.includes('chrome.tabs.sendMessage(tabId, message, { frameId })')) throw new Error('frame routing must address one concrete frame at a time')
if (!support.includes('ambiguous selector matched')) throw new Error('frame mutation must fail closed on cross-frame selector ambiguity')
if (!support.includes('frame-url(') || !support.includes('stableFrameUrl')) throw new Error('nested-frame selectors must retain a durable URL-qualified replay hint')
if (!support.includes('renderStructuredTables')) throw new Error('browser_read_page must surface structured frame tables')

console.log('frame-aware browser bridge checks passed')
