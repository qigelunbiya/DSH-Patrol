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
if (!manifest.content_scripts?.some(item => Array.isArray(item.js) && item.js.includes('captcha-demo-content.js'))) throw new Error('owned-site captcha demo content bridge is missing from the extension manifest')

for (const file of ['background.js', 'content.js', 'captcha-demo-content.js', 'popup.js', 'options.js']) {
  checkSyntax(join(extensionRoot, file), file)
}
for (const file of ['index.js', 'bridge.js', 'managed-browser.js', 'tools.js', 'count-tool.js', 'login-state-tool.js', 'challenge-tool.js', 'image-code.js', 'captcha-demo.js', 'screenshot-ocr.js', 'tools-plugin.js', 'ws.js']) {
  checkSyntax(join(runtimeRoot, file), `browser-bridge-runtime/${file}`)
}

const content = readFileSync(join(extensionRoot, 'content.js'), 'utf8')
if (/\beval\s*\(/.test(content) || /new\s+Function\s*\(/.test(content)) throw new Error('page eval is forbidden in Patrol extension')
if (!content.includes("input.type === 'password'")) throw new Error('password-field redaction guard missing')
if (!content.includes('return { ok: false, found: false, selector: args.selector')) throw new Error('selector wait timeout must fail closed')
if (!content.includes("case 'count': return count(args)")) throw new Error('safe DOM count command is missing')
if (!content.includes('document.querySelectorAll(args.selector)')) throw new Error('DOM count must be selector-only')

const captchaDemoContent = readFileSync(join(extensionRoot, 'captcha-demo-content.js'), 'utf8')
if (/\beval\s*\(/.test(captchaDemoContent) || /new\s+Function\s*\(/.test(captchaDemoContent)) throw new Error('captcha demo content bridge must not evaluate page code')
if (!captchaDemoContent.includes('data-dsh-patrol-captcha-kind')) throw new Error('captcha demo content bridge must still recognize explicit challenge markup')
if (!captchaDemoContent.includes('weakDemoEntries') || !captchaDemoContent.includes('detectWeakClickSequence') || !captchaDemoContent.includes('detectWeakSliderPuzzle')) throw new Error('captcha demo availability must support weak auto-detection for unmarked click and slider challenges')
if (!captchaDemoContent.includes('DOCUMENT_KEY') || !captchaDemoContent.includes('assertDocumentKey')) throw new Error('captcha demo page actions must reject stale page instances')
if (!captchaDemoContent.includes('CHALLENGE_KEYS') || !captchaDemoContent.includes('assertCurrentChallenge')) throw new Error('captcha demo actions must reject stale same-document challenge instances')
if (!captchaDemoContent.includes('requestedDistance = backgroundRect.width * normalizedX')) throw new Error('captcha slider must use relative puzzle travel distance')

const runtimeTools = readFileSync(join(runtimeRoot, 'tools.js'), 'utf8')
if (/name:\s*['"]browser_eval['"]/.test(runtimeTools)) throw new Error('browser_eval must not be registered by Patrol')
if (!runtimeTools.includes("name: 'browser_type_credential'")) throw new Error('credential-reference browser tool is missing')
if (!runtimeTools.includes('function requireOk')) throw new Error('runtime must fail closed on in-band browser errors')
if (runtimeTools.includes('text: resolved.value') && !runtimeTools.includes("run(bridge, exec, 'type'")) {
  throw new Error('credential resolution must only feed the direct bridge request')
}
if (!runtimeTools.includes("ocrStatus: ocr.status")) throw new Error('browser_screenshot must return built-in OCR status')
if (!runtimeTools.includes("status: 'verification-suppressed'")) throw new Error('screenshot OCR must fail closed on human verification')
if (!runtimeTools.includes('UNTRUSTED SCREENSHOT OCR')) throw new Error('screenshot OCR must be clearly marked as untrusted page data')

const countTool = readFileSync(join(runtimeRoot, 'count-tool.js'), 'utf8')
if (!countTool.includes("name: 'browser_count'")) throw new Error('browser_count tool is missing')
if (countTool.includes('eval(') || countTool.includes('new Function')) throw new Error('browser_count must not evaluate page code')

const loginStateTool = readFileSync(join(runtimeRoot, 'login-state-tool.js'), 'utf8')
if (!loginStateTool.includes("name: 'browser_login_state'")) throw new Error('browser_login_state tool is missing')
if (!loginStateTool.includes("bridge.request('snapshot'")) throw new Error('login-state detection must use the safe snapshot provider')
if (/cookie/i.test(loginStateTool) && /getAll|getCookie|cookies\.get/.test(loginStateTool)) throw new Error('login-state detector must not read raw cookie values')
if (/\beval\s*\(/.test(loginStateTool) || /new\s+Function\s*\(/.test(loginStateTool)) throw new Error('login-state detector must not evaluate page code')

const challengeTool = readFileSync(join(runtimeRoot, 'challenge-tool.js'), 'utf8')
if (!challengeTool.includes("name: 'browser_detect_auth_challenge'")) throw new Error('browser_detect_auth_challenge tool is missing')
if (!challengeTool.includes("bridge.request('snapshot'")) throw new Error('auth challenge detection must use the safe snapshot provider')
if (!challengeTool.includes("bridge.request('readPage'")) throw new Error('auth challenge detection must use visible page text only')
if (/\beval\s*\(/.test(challengeTool) || /new\s+Function\s*\(/.test(challengeTool)) throw new Error('auth challenge detection must not evaluate page code')
if (/bridge\.request\(['"](?:click|drag)/.test(challengeTool)) throw new Error('auth challenge detector must not expose a general direct click/drag solver')
if (!challengeTool.includes("classified.subtype === 'image-code'")) throw new Error('conventional image-text OCR path is missing')
for (const strategy of ['manual-click-sequence', 'manual-slider', 'manual-third-party']) {
  if (!challengeTool.includes(strategy)) throw new Error(`interactive verification must retain deterministic handoff strategy ${strategy}`)
}
if (!challengeTool.includes('trySolveOwnedSiteChallenge') || !challengeTool.includes('probeOwnedSiteChallenge')) throw new Error('captcha demo solver integration and re-detection are missing')
if (!challengeTool.includes('ambiguousDemoFallback') || !challengeTool.includes('demo.visibleKinds')) throw new Error('ambiguous visible captcha markup must fail closed to handoff')
if (!challengeTool.includes('observedKind') || !challengeTool.includes('observedSubtype')) throw new Error('challenge detector must preserve initially observed taxonomy for learned Runbook metadata')
if (!challengeTool.includes('value.autoFilled && !value.handoffRequired')) throw new Error('challenge renderer must not claim completion while a handoff is still required')

const captchaDemo = readFileSync(join(runtimeRoot, 'captcha-demo.js'), 'utf8')
if (!captchaDemo.includes("bridge.request('captchaDemoInfo'")) throw new Error('captcha demo runtime must probe available demo challenge signals')
if (!captchaDemo.includes('info.available === true')) throw new Error('captcha demo runtime must require a confirmed visible click/slider challenge candidate')
if (!captchaDemo.includes('capture.available === true')) throw new Error('captcha demo runtime must only continue on confirmed demo captures')
if (!captchaDemo.includes('capture.documentKey === documentKey')) throw new Error('captcha demo capture must match the discovered page instance')
if (!captchaDemo.includes('capture.challengeKey === challengeKey')) throw new Error('captcha demo capture must match the discovered challenge instance')
if (!captchaDemo.includes("classified?.subtype === 'generic-captcha'")) throw new Error('demo challenge probing must be able to refine weak generic captcha classification')
if (!captchaDemo.includes('visibleKinds: info.kinds')) throw new Error('captcha demo runtime must expose visible families for ambiguous handoff')
if (!captchaDemo.includes("subtype === 'click-sequence'")) throw new Error('captcha demo ordered-click solver is missing')
if (!captchaDemo.includes("subtype === 'slider-puzzle'")) throw new Error('captcha demo slider-puzzle solver is missing')
if (captchaDemo.includes("operation: 'third-party'") || captchaDemo.includes("kind: 'third-party'")) {
  throw new Error('captcha demo runtime must not implement third-party anti-bot solver paths')
}

const screenshotOcr = readFileSync(join(runtimeRoot, 'screenshot-ocr.js'), 'utf8')
if (/\beval\s*\(/.test(screenshotOcr) || /new\s+Function\s*\(/.test(screenshotOcr)) throw new Error('screenshot OCR must not evaluate page code')
if (!screenshotOcr.includes("@napi-rs/system-ocr")) throw new Error('screenshot OCR must use the bundled system OCR dependency')

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
if (!/registerLoginStateTool\(ctx,\s*bridge,/.test(toolPlugin)) throw new Error('browser tools plugin must register scoped login-state detection')

const preset = readFileSync(join(projectRoot, 'presets', 'patrol', 'agent.cordis.yml'), 'utf8')
if (!preset.includes("name: 'dsh-patrol/browser-tools'")) throw new Error('Patrol preset must load the agent-scoped browser tools plugin')
if (preset.includes("name: 'dsh-patrol/browser-bridge'")) throw new Error('Patrol preset must not own the process-global browser transport')
if (!preset.includes('storagePath: .dsh-patrol')) throw new Error('Patrol preset must default to workspace-local storage')

const hostPatch = readFileSync(join(projectRoot, 'cordis.patch.yml'), 'utf8')
if (!hostPatch.includes("name: 'dsh-patrol/browser-bridge-host'")) throw new Error('DSH Patrol host patch must load the browser transport')

const background = readFileSync(join(extensionRoot, 'background.js'), 'utf8')
if (!background.includes('value.ok === false')) throw new Error('extension must convert in-band DOM failures into bridge failures')
if (!background.includes("case 'count':")) throw new Error('extension background must route count to the DOM bridge')
if (!background.includes("case 'captureCaptchaDemo':")) throw new Error('extension background must capture captcha demo assets')
if (!background.includes("type: 'dsh-patrol:captcha-demo'")) throw new Error('captcha demo commands must use a separate page message channel')
if (!background.includes('documentKey: target.documentKey')) throw new Error('captcha demo capture must preserve page instance identity')
if (!background.includes('challengeKey: target.challengeKey')) throw new Error('captcha demo capture must preserve challenge instance identity')
if (!background.includes('target.imageRect, target.viewport, 0') || !background.includes('target.backgroundRect, target.viewport, 0')) throw new Error('captcha demo solver crops must not add coordinate-shifting padding')

console.log('browser extension/runtime and host/agent plane checks passed')

function checkSyntax(path, label) {
  const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${label} syntax check failed:\n${result.stderr}`)
}
