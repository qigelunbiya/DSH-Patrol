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
const dashboardPath = resolve(root, 'browser-bridge-runtime', 'dashboard-fast.js')
const dashboard = readFileSync(dashboardPath, 'utf8')
const dashboardRuntimePath = resolve(root, 'browser-bridge-runtime', 'dashboard-runtime.js')
const dashboardRuntime = readFileSync(dashboardRuntimePath, 'utf8')
const dashboardClientPath = resolve(root, 'browser-bridge-runtime', 'dashboard-client.js')
const dashboardClient = readFileSync(dashboardClientPath, 'utf8')
const dashboardRecordsPath = resolve(root, 'browser-bridge-runtime', 'dashboard-records-client.js')
const dashboardRecords = readFileSync(dashboardRecordsPath, 'utf8')
const dashboardBatchPath = resolve(root, 'browser-bridge-runtime', 'dashboard-batch-records.js')
const dashboardBatch = readFileSync(dashboardBatchPath, 'utf8')
const bridgeHost = readFileSync(resolve(root, 'browser-bridge-runtime', 'index.js'), 'utf8')
const store = readFileSync(resolve(root, 'src', 'store.ts'), 'utf8')
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
const expectedClientInject = [
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-input-trigger',
]
if (JSON.stringify(clientInject) !== JSON.stringify(expectedClientInject)) {
  throw new Error('client host dsh.client.inject must stay on the cross-version conversation + input-trigger package edges only')
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
  "exports.inject = ['slots', 'sessions', 'inputTriggers'];",
  "const DASHBOARD_UI = '/patrol-browser-bridge/dashboard/ui';",
  "const FLOW_CATALOG_API = '/patrol-browser-bridge/dashboard/catalog';",
  "const BROWSER_VISIBILITY_API = '/patrol-browser-bridge/browser-visibility';",
  'function registerPatrolFlowReferenceSource(ctx)',
  'return `@flow:${value.id}`;',
  "name: 'conversation.session.header.actions', id: 'dsh-patrol-runtime-controls'",
  'function createFlowChooser(workspaceRoot, runFlows)',
  'data-dsh-patrol-flow-execute',
  'data-dsh-patrol-flow-select',
  'data-dsh-patrol-batch-confirm-list',
  'async function sendFlowSelectionReplay(ctx, sessionId, flows)',
  'await runFlows(selectedFlows.map(flow => ({ id: flow.id, name: flow.name })));',
  '请一次调用 patrol_run_batch',
  'function mountPatrolHeroControls(ctx)',
  "run.textContent = '选择流程'",
  "browser.textContent = '浏览器设置'",
  'function canSubmitDraft(inputActions)',
  'function DashboardFrame({ useSession, workspaceRoot, mode, inputActions })',
  'if (!canSubmitDraft(inputActions))',
  'function currentInspectionId(nodes, runningCalls)',
  "mode: 'flows'",
  "mode: 'records'",
  "registerView(ctx, 'patrol-flow', 30, '流程管理'",
  "registerView(ctx, 'patrol-records', 40, '巡检记录'",
  'summary.agentPreset === PATROL_PRESET_ID',
  'summary.projectionValues.agentPreset === PATROL_PRESET_ID',
  'function TokenManager({ embedded = false })',
  'function mountTokenSidebarEntry(openTokenSurface)',
  "if (typeof openTokenSurface === 'function' && openTokenSurface()) return;",
  "betterSidebar.openTab({ type: TOTP_TAB_ID, title: '令牌', path: 'dsh-patrol://totp' });",
  "const TOTP_API_ROOT = '/patrol-browser-bridge/totp';",
  "ctx.inject(['betterSidebar']",
  'service.registerTab({',
  "name: 'sidebar.footer.action', id: 'dsh-patrol-token-bridge'",
  'function readFileDataUrl(file)',
  "totpPost('import-image', csrf",
  "type: 'password'",
  "'x-dsh-patrol-csrf': csrf",
]) {
  if (!client.includes(marker)) throw new Error(`client bundle is missing marker: ${marker}`)
}

for (const marker of [
  'registerPatrolDashboardRoutes',
  "path: `${prefix}/catalog`",
  "path: `${prefix}/run`",
  "path: `${prefix}/artifact`",
  'export async function buildPatrolDashboardCatalog(storageRoot, workspace)',
  'async function loadRunSummary(storageRoot, definition, runId)',
  'export function parseLegacyMarkdownSummary(markdown, definition, runId)',
  'const MAX_FAST_JSON_BYTES = 512 * 1024',
  'const MAX_RUNS_PER_INSPECTION = 2000',
  'async function mapLimit(items, limit, worker)',
  'function artifactCandidates(storageRoot, report)',
]) {
  if (!dashboard.includes(marker)) throw new Error(`dashboard data runtime is missing marker: ${marker}`)
}

for (const marker of [
  "import { registerPatrolDashboardRoutes as registerBoundedDashboardRoutes } from './dashboard-fast.js'",
  "import { registerPatrolDashboardBatchRoutes } from './dashboard-batch-records.js'",
  "url.searchParams.get('asset') === 'client'",
  "url.searchParams.get('asset') === 'records'",
  "const mode = url.searchParams.get('mode') === 'records' ? 'records' : 'flows'",
  "'content-type': 'text/javascript; charset=utf-8'",
  "script-src 'self'",
  "function dashboardShell(prefix, mode = 'flows')",
]) {
  if (!dashboardRuntime.includes(marker)) throw new Error(`dashboard shell runtime is missing marker: ${marker}`)
}

for (const marker of [
  "const API = location.pathname.replace(/\\/ui$/, '')",
  'async function get(path, timeout = 12000)',
  'function renderFlows()',
  'function renderRecords()',
  'function renderRunDetail()',
  'function logsView(report, definition)',
  "root?.addEventListener('click'",
]) {
  if (!dashboardClient.includes(marker)) throw new Error(`dashboard browser client is missing marker: ${marker}`)
}

for (const marker of [
  'export function registerPatrolDashboardBatchRoutes(ctx, basePath, config = {})',
  "path: `${prefix}/batches`",
  "path: `${prefix}/batch`",
  'export async function listBatchRecords(storageRoot, workspace)',
  'export async function loadBatchDetail(storageRoot, workspace, batchRunId)',
  "recordType: 'batch'",
  "join(storageRoot, 'batches', batchRunId, 'state.json')",
]) {
  if (!dashboardBatch.includes(marker)) throw new Error(`batch dashboard data runtime is missing marker: ${marker}`)
}

for (const marker of [
  'function topLevelRecords()',
  "recordType: 'single'",
  "record.recordType === 'batch'",
  'function renderBatchDetail()',
  'function renderBatchOverview(batch)',
  'data-batch-child-run',
  '<option value="batch">批量巡检</option>',
  "get(`/batch?workspace=${encodeURIComponent(WORKSPACE)}&batchRunId=${encodeURIComponent(batchRunId)}`",
]) {
  if (!dashboardRecords.includes(marker)) throw new Error(`batch records client is missing marker: ${marker}`)
}

if (!bridgeHost.includes("import { registerPatrolDashboardRoutes } from './dashboard-runtime.js'")) {
  throw new Error('browser bridge host must import the parse-safe Patrol dashboard runtime')
}
if (!bridgeHost.includes('registerPatrolDashboardRoutes(ctx, path, config)')) {
  throw new Error('browser bridge host must mount the Patrol dashboard routes')
}
if (!bridgeHost.includes("import { defaultPatrolLaunchBrowser } from './background-browser-launch.js'")) {
  throw new Error('browser bridge host must launch managed Chromium through the visibility-aware launcher')
}
if (!bridgeHost.includes('registerBrowserVisibilityRoutes(ctx, path')) {
  throw new Error('browser bridge host must mount persisted browser visibility controls')
}
for (const marker of [
  "join(internal.directory, 'summary.json')",
  "join(dirname(visible.json), 'summary.json')",
  'function runIndexSummary(report: RunReport)',
  'async organizeTeachingScreenshot(inspectionId: string, sourcePath: string, workspaceRoot: string)',
]) {
  if (!store.includes(marker)) throw new Error(`PatrolStore is missing workspace-output marker: ${marker}`)
}

for (const forbidden of [
  'eventSource',
  'useEventWindow',
  '.cloneNode(',
  'currentTotpCode',
  'generateTotpForProfile',
  'PATROL_SECRET_',
  'window.BarcodeDetector',
]) {
  if (client.includes(forbidden)) throw new Error(`client bundle contains forbidden compatibility/security marker: ${forbidden}`)
}

for (const file of [
  resolve(carrierRoot, 'index.js'),
  clientPath,
  dashboardPath,
  dashboardRuntimePath,
  dashboardClientPath,
  dashboardRecordsPath,
  dashboardBatchPath,
]) {
  const syntax = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (syntax.status !== 0) {
    throw new Error(`Patrol web runtime syntax check failed for ${file}:\n${syntax.stderr || syntax.stdout}`)
  }
}

console.log('Patrol client host runtime checks passed')
