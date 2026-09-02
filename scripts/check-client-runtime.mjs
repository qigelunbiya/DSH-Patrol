import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const clientPath = resolve(root, 'client-runtime', 'client.js')
const client = readFileSync(clientPath, 'utf8')

if (packageJson.exports?.['./client']?.default !== './client-runtime/client.js') {
  throw new Error('package.json must export ./client from ./client-runtime/client.js')
}
if (packageJson.dsh?.client?.platform !== 'web') {
  throw new Error('package.json must declare dsh.client.platform=web')
}
for (const dependency of [
  '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-renderer',
]) {
  if (!packageJson.dsh.client.inject?.includes(dependency)) {
    throw new Error(`dsh.client.inject is missing ${dependency}`)
  }
}
// dsh.client.inject contains browser plugin package rows, not every runtime
// service provider. ui-slots is statically linked into the web shell and has
// no dsh.client row, so declaring it here creates an unsatisfiable dependency
// edge and prevents the Patrol browser plugin from activating.
if (packageJson.dsh.client.inject?.includes('@deepseek-ai/dsh-client-ui-slots')) {
  throw new Error('dsh.client.inject must not include static package @deepseek-ai/dsh-client-ui-slots')
}
for (const marker of [
  "window.__ModuleLoader__.load({ id: 'dsh-patrol'",
  "exports.inject = ['slots', 'sessions'];",
  "registerView(ctx, 'patrol-flow', 30, '流程管理'",
  "registerView(ctx, 'patrol-records', 40, '巡检记录'",
  "name: 'conversation.view'",
]) {
  if (!client.includes(marker)) throw new Error(`client bundle is missing marker: ${marker}`)
}

const syntax = spawnSync(process.execPath, ['--check', clientPath], { encoding: 'utf8' })
if (syntax.status !== 0) {
  throw new Error(`client bundle syntax check failed:\n${syntax.stderr || syntax.stdout}`)
}

console.log('Patrol client runtime checks passed')
