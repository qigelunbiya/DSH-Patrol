import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
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
for (const file of ['index.js', 'bridge.js', 'managed-browser.js', 'tools.js', 'count-tool.js', 'challenge-tool.js', 'tools-plugin.js', 'ws.js']) {
  checkSyntax(join(runtimeRoot, file), `browser-bridge-runtime/${file}`)
}

const content = readFileSync(join(extensionRoot, 'content.js'), 'utf8')
if (/\beval\s*\(/.test(content) || /new\s+Function\s*\(/.test(content)) throw new Error('page eval is forbidden in Patrol extension')
if (!content.includes("input.type === 'password'")) throw new Error('password-field redaction guard missing')
if (!content.includes('return { ok: false, found: false, selector: args.selector')) throw new Error('selector wait timeout must fail closed')
if (!content.includes("case 'count': return count(args)")) throw new Error('safe DOM count command is missing')
if (!content.includes('document.querySelectorAll(args.selector)')) throw new Error('DOM count must be selector-only')

const runtimeTools = readFileSync(join(runtimeRoot, 'tools.js'), 'utf8')
if (/name:\s*['"]browser_eval['"]/.test(runtimeTools)) throw new Error('browser_eval must not be registered by Patrol')
if (!runtimeTools.includes("name: 'browser_type_credential'")) throw new Error('credential-reference browser tool is missing')
if (!runtimeTools.includes('function requireOk')) throw new Error('runtime must fail closed on in-band browser errors')
if (runtimeTools.includes('text: resolved.value') && !runtimeTools.includes("run(bridge, exec, 'type'")) {
  throw new Error('credential resolution must only feed the direct bridge request')
}

const countTool = readFileSync(join(runtimeRoot, 'count-tool.js'), 'utf8')
if (!countTool.includes("name: 'browser_count'")) throw new Error('browser_count tool is missing')
if (countTool.includes('eval(') || countTool.includes('new Function')) throw new Error('browser_count must not evaluate page code')

const challengeTool = readFileSync(join(runtimeRoot, 'challenge-tool.js'), 'utf8')
if (!challengeTool.includes("name: 'browser_detect_auth_challenge'")) throw new Error('browser_detect_auth_challenge tool is missing')
if (!challengeTool.includes("bridge.request('snapshot'")) throw new Error('auth challenge detection must use the safe snapshot provider')
if (!challengeTool.includes("bridge.request('readPage'")) throw new Error('auth challenge detection must use visible page text only')
if (/\beval\s*\(/.test(challengeTool) || /new\s+Function\s*\(/.test(challengeTool)) throw new Error('auth challenge detection must not evaluate page code')
if (/\bocr\b/i.test(challengeTool) || /drag(To)?\s*\(/.test(challengeTool)) throw new Error('auth challenge detector must classify only; no OCR/drag solving logic is allowed')

const runtimeIndex = readFileSync(join(runtimeRoot, 'index.js'), 'utf8')
if (!runtimeIndex.includes('chrome-extension:')) throw new Error('browser websocket origin restriction is missing')
if (!runtimeIndex.includes('trusted-extension-origin.txt')) throw new Error('browser extension origin pairing is missing')
if (runtimeIndex.indexOf('handleUpgrade(req, socket, head') > runtimeIndex.indexOf('authorizeOrigin(originTrustFile')) throw new Error('extension origin must not be persisted before a valid WebSocket handshake')
if (!runtimeIndex.includes("export const inject = ['webServer']")) throw new Error('browser transport must be host-plane and inject only webServer')
if (/^\s*export\s+default\b/m.test(runtimeIndex)) throw new Error('host browser transport must not default-export apply: Harness Loader would drop inject metadata')
if (runtimeIndex.includes('registerTools(')) throw new Error('host browser transport must not register agent browser tools')
if (!runtimeIndex.includes("ctx.provide('patrolBrowserBridge'")) throw new Error('host browser transport must provide patrolBrowserBridge')
if (!runtimeIndex.includes('ensureBrowser:')) throw new Error('host browser transport must expose zero-config managed browser provisioning')

const toolPlugin = readFileSync(join(runtimeRoot, 'tools-plugin.js'), 'utf8')
if (!toolPlugin.includes("export const inject = ['tools', 'patrolBrowserBridge']")) throw new Error('browser tools plugin must consume the host patrolBrowserBridge service')
if (/^\s*export\s+default\b/m.test(toolPlugin)) throw new Error('browser tools plugin must not default-export apply: Harness Loader would drop inject metadata')
if (!toolPlugin.includes('service.ensureBrowser')) throw new Error('browser tools plugin must request managed browser provisioning')
if (!toolPlugin.includes('service.bridge.request')) throw new Error('browser tools plugin wrapper must delegate requests to the host bridge')
if (!toolPlugin.includes('service.bridge.saveScreenshot')) throw new Error('browser tools plugin wrapper must delegate screenshot persistence to the host bridge')
if (!/registerTools\(ctx,\s*bridge,/.test(toolPlugin)) throw new Error('browser tools plugin must register scoped tools through the managed bridge wrapper')
if (!/registerCountTool\(ctx,\s*bridge,/.test(toolPlugin)) throw new Error('browser tools plugin must register scoped browser_count')
if (!/registerChallengeTool\(ctx,\s*bridge,/.test(toolPlugin)) throw new Error('browser tools plugin must register scoped auth challenge detection')

const preset = readFileSync(join(projectRoot, 'presets', 'patrol', 'agent.cordis.yml'), 'utf8')
if (!preset.includes("name: 'dsh-patrol/browser-tools'")) throw new Error('Patrol preset must load the agent-scoped browser tools plugin')
if (preset.includes("name: 'dsh-patrol/browser-bridge'")) throw new Error('Patrol preset must not own the process-global browser transport')
if (!preset.includes('storagePath: .dsh-patrol')) throw new Error('Patrol preset must default to workspace-local storage')

const hostPatch = readFileSync(join(projectRoot, 'cordis.patch.yml'), 'utf8')
if (!hostPatch.includes("name: 'dsh-patrol/browser-bridge-host'")) throw new Error('DSH Patrol host patch must load the browser transport')

const background = readFileSync(join(extensionRoot, 'background.js'), 'utf8')
if (!background.includes('value.ok === false')) throw new Error('extension must convert in-band DOM failures into bridge failures')
if (!background.includes("case 'count':")) throw new Error('extension background must route count to the DOM bridge')

console.log('browser extension/runtime and host/agent plane checks passed')

function checkSyntax(path, label) {
  const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${label} syntax check failed:\n${result.stderr}`)
}
