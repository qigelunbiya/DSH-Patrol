import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const extensionRoot = fileURLToPath(new URL('../browser-extension/', import.meta.url))
const runtimeRoot = fileURLToPath(new URL('../browser-bridge-runtime/', import.meta.url))
const manifest = JSON.parse(readFileSync(join(extensionRoot, 'manifest.json'), 'utf8'))
if (manifest.manifest_version !== 3) throw new Error('browser extension must be Manifest V3')
if (!String(manifest.content_security_policy?.extension_pages ?? '').includes("script-src 'self'")) throw new Error('extension CSP must restrict scripts to self')
if (String(manifest.content_security_policy?.extension_pages ?? '').includes('unsafe-eval')) throw new Error('unsafe-eval is forbidden')
if (manifest.content_scripts?.some(item => item.all_frames === true)) throw new Error('Patrol extension content scripts must not run in every frame')

for (const file of ['background.js', 'content.js', 'popup.js', 'options.js']) {
  checkSyntax(join(extensionRoot, file), file)
}
for (const file of ['index.js', 'bridge.js', 'tools.js', 'ws.js']) {
  checkSyntax(join(runtimeRoot, file), `browser-bridge-runtime/${file}`)
}

const content = readFileSync(join(extensionRoot, 'content.js'), 'utf8')
if (/\beval\s*\(/.test(content) || /new\s+Function\s*\(/.test(content)) throw new Error('page eval is forbidden in Patrol extension')
if (!content.includes("input.type === 'password'")) throw new Error('password-field redaction guard missing')
const runtimeTools = readFileSync(join(runtimeRoot, 'tools.js'), 'utf8')
if (/name:\s*['\"]browser_eval['\"]/.test(runtimeTools)) throw new Error('browser_eval must not be registered by Patrol')
if (!runtimeTools.includes("name: 'browser_type_credential'")) throw new Error('credential-reference browser tool is missing')
const runtimeIndex = readFileSync(join(runtimeRoot, 'index.js'), 'utf8')
if (!runtimeIndex.includes('chrome-extension:')) throw new Error('browser websocket origin restriction is missing')
if (!runtimeIndex.includes('trusted-extension-origin.txt')) throw new Error('browser extension origin pairing is missing')
if (runtimeIndex.indexOf('handleUpgrade(req, socket, head') > runtimeIndex.indexOf('authorizeOrigin(originTrustFile')) throw new Error('extension origin must not be persisted before a valid WebSocket handshake')
const background = readFileSync(join(extensionRoot, 'background.js'), 'utf8')
if (!background.includes('value.ok === false')) throw new Error('extension must convert in-band DOM failures into bridge failures')
if (!runtimeTools.includes('function requireOk')) throw new Error('runtime must fail closed on in-band browser errors')
if (runtimeTools.includes('text: resolved.value') && !runtimeTools.includes("run(bridge, exec, 'type'")) {
  throw new Error('credential resolution must only feed the direct bridge request')
}
console.log('browser extension/runtime checks passed')

function checkSyntax(path, label) {
  const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${label} syntax check failed:\n${result.stderr}`)
}
