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
for (const dependency of [
  '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-renderer',
]) {
  if (!carrierPackage.dsh.client.inject?.includes(dependency)) {
    throw new Error(`client host dsh.client.inject is missing ${dependency}`)
  }
}
if (carrierPackage.dsh.client.inject?.includes('@deepseek-ai/dsh-client-ui-slots')) {
  throw new Error('client host dsh.client.inject must not include static package @deepseek-ai/dsh-client-ui-slots')
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
  'browser-bridge-runtime\\index.js',
  'client-host-runtime',
  'id: dsh-patrol-browser-host',
  'id: dsh-patrol-client-host',
  "name: 'dsh-patrol-client-host'",
  'node_modules\\dsh-patrol-client-host\\package.json',
]) {
  if (!installer.includes(marker)) throw new Error(`install-local.ps1 is missing client profile dependency marker: ${marker}`)
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
  "projectionValues.agentPreset === PATROL_PRESET_ID",
  "registerView(ctx, 'patrol-flow', 30, '流程管理'",
  "registerView(ctx, 'patrol-records', 40, '巡检记录'",
  "name: 'conversation.view'",
]) {
  if (!client.includes(marker)) throw new Error(`client bundle is missing marker: ${marker}`)
}

for (const file of [resolve(carrierRoot, 'index.js'), clientPath]) {
  const syntax = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (syntax.status !== 0) {
    throw new Error(`client host syntax check failed for ${file}:\n${syntax.stderr || syntax.stdout}`)
  }
}

console.log('Patrol client host runtime checks passed')
