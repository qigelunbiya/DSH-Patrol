import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const rootPackage = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const carrierRoot = resolve(root, 'client-host-runtime')
const carrierPackage = JSON.parse(readFileSync(resolve(carrierRoot, 'package.json'), 'utf8'))
const carrierIndex = readFileSync(resolve(carrierRoot, 'index.js'), 'utf8')
const clientPath = resolve(carrierRoot, 'client.js')
const client = readFileSync(clientPath, 'utf8')
const installer = readFileSync(resolve(root, 'scripts', 'install-local.ps1'), 'utf8')
const uninstaller = readFileSync(resolve(root, 'scripts', 'uninstall-local.ps1'), 'utf8')

if (rootPackage.dsh?.client !== undefined) {
  throw new Error('root dsh-patrol package must not declare dsh.client; its agent and browser-tool Loader sources would collide')
}
if (carrierPackage.name !== 'dsh-patrol-client-host') {
  throw new Error('client host package must use the dsh-patrol-client-host browser module id')
}
if (carrierPackage.exports?.['./client'] !== './client.js') {
  throw new Error('client host package must export ./client from ./client.js')
}
if (carrierPackage.dsh?.client?.platform !== 'web') {
  throw new Error('client host package must declare dsh.client.platform=web')
}
const clientInject = carrierPackage.dsh.client.inject ?? []
if (JSON.stringify(clientInject) !== JSON.stringify(['@deepseek-ai/dsh-client-ui-conversation'])) {
  throw new Error('client host dsh.client.inject must stay on the cross-version conversation package edge only')
}
for (const versionSpecificDependency of [
  '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-ui-slots',
]) {
  if (clientInject.includes(versionSpecificDependency)) {
    throw new Error(`client host dsh.client.inject contains version-specific dependency ${versionSpecificDependency}`)
  }
}
for (const marker of [
  "export const name = 'dsh-patrol-client-host'",
  'export const inject = []',
  'export function apply() {}',
]) {
  if (!carrierIndex.includes(marker)) throw new Error(`client host anchor is missing marker: ${marker}`)
}
if (carrierIndex.includes("../browser-bridge-runtime/index.js")) {
  throw new Error('client host anchor must not reuse the browser bridge host row')
}
for (const marker of [
  'function Install-ClientHostDependency',
  'pnpm add --save-prod $ClientHostRoot',
  'function Install-HarnessClientHostCompatMirror',
  'node_modules\\dsh-patrol-client-host',
  '.managed-by-dsh-patrol',
  "require.resolve('dsh-patrol-client-host/package.json')",
  'browser-bridge-runtime\\index.js',
  'client-host-runtime',
  'id: dsh-patrol-browser-host',
  'id: dsh-patrol-client-host',
  "name: 'dsh-patrol-client-host'",
  'node_modules\\dsh-patrol-client-host\\package.json',
]) {
  if (!installer.includes(marker)) throw new Error(`install-local.ps1 is missing client compatibility marker: ${marker}`)
}
for (const forbidden of ['-ClientHostUri $ClientHostIndex', "$ClientHostIndex ="] ) {
  if (installer.includes(forbidden)) throw new Error(`install-local.ps1 still contains obsolete file-URL carrier marker: ${forbidden}`)
}
if (!uninstaller.includes('pnpm remove dsh-patrol-client-host')) {
  throw new Error('uninstall-local.ps1 must remove the Patrol client carrier profile dependency')
}

for (const marker of [
  "window.__ModuleLoader__.load({ id: 'dsh-patrol-client-host'",
  "exports.inject = ['slots', 'sessions'];",
  'function FlowView({ useSession, loadOlder })',
  'function RecordsView({ useSession, loadOlder })',
  'function TokenManager({ embedded = false })',
  'function mountTokenSidebarEntry()',
  "const TOTP_API_ROOT = '/patrol-browser-bridge/totp';",
  "const TOTP_ENTRY_SELECTOR = '[data-dsh-patrol-token-entry]';",
  "root.querySelector('[data-dsh-ssh-entry]')",
  "entry.setAttribute('data-dsh-plugin', 'patrol-token')",
  "entry.setAttribute('data-dsh-part', 'sidebar-entry')",
  'new MutationObserver(',
  'new ResizeObserver(',
  "ctx.inject(['betterSidebar']",
  'service.registerTab({',
  'betterSidebar.openTab({ type: TOTP_TAB_ID',
  "name: 'sidebar.footer.action', id: 'dsh-patrol-token-bridge'",
  'window.BarcodeDetector',
  "type: 'password'",
  "'x-dsh-patrol-csrf': csrf",
  'snapshot.nodes',
  'snapshot.runningCalls',
  'snapshot.hasMore',
  'binding.session.getSnapshot()',
  'summary.agentPreset === PATROL_PRESET_ID',
  'summary.projectionValues.agentPreset === PATROL_PRESET_ID',
  "registerView(ctx, 'patrol-flow', 30, '流程管理'",
  "registerView(ctx, 'patrol-records', 40, '巡检记录'",
  "name: 'conversation.view'",
]) {
  if (!client.includes(marker)) throw new Error(`client bundle is missing marker: ${marker}`)
}

for (const forbidden of [
  'eventSource',
  'useEventWindow',
  '.cloneNode(',
  'currentTotpCode',
  'generateTotpForProfile',
  'PATROL_SECRET_',
]) {
  if (client.includes(forbidden)) throw new Error(`client bundle contains forbidden compatibility/security marker: ${forbidden}`)
}

for (const file of [resolve(carrierRoot, 'index.js'), clientPath]) {
  const syntax = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (syntax.status !== 0) {
    throw new Error(`client host syntax check failed for ${file}:\n${syntax.stderr || syntax.stdout}`)
  }
}

console.log('Patrol client host runtime checks passed')
