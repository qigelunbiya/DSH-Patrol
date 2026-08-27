import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const managedPath = join(root, 'browser-bridge-runtime', 'managed-browser.js')
const toolsPluginPath = join(root, 'browser-bridge-runtime', 'tools-plugin.js')
const manifestPath = join(root, 'browser-extension', 'manifest.json')

const [managed, toolsPlugin, manifestRaw] = await Promise.all([
  readFile(managedPath, 'utf8'),
  readFile(toolsPluginPath, 'utf8'),
  readFile(manifestPath, 'utf8'),
])
const manifest = JSON.parse(manifestRaw)

const errors = []
if (typeof manifest.key !== 'string' || manifest.key.length < 100) {
  errors.push('browser-extension/manifest.json must pin a stable extension key for managed installs')
}
if (!managed.includes("from 'puppeteer-core'")) errors.push('managed browser must use puppeteer-core')
if (!managed.includes('pipe: true')) errors.push('managed browser must use CDP pipe transport')
if (!managed.includes('enableExtensions: true')) errors.push('managed browser must enable extensions explicitly')
if (!managed.includes('installExtension(extensionPath)')) errors.push('managed browser must install the bundled extension programmatically')
if (managed.includes('--load-extension')) errors.push('managed browser must not use deprecated --load-extension')
if (!managed.includes("'browser-profile'")) errors.push('managed browser must use an isolated persistent Patrol profile')
if (!toolsPlugin.includes('service.ensureBrowser')) errors.push('Patrol preset must trigger managed browser provisioning automatically')
if (toolsPlugin.includes('chrome://extensions') || toolsPlugin.includes('Load unpacked')) {
  errors.push('browser tools must not instruct users to install the extension manually')
}

if (errors.length > 0) {
  console.error('Managed browser checks failed:')
  for (const error of errors) console.error(`- ${error}`)
  process.exit(1)
}
console.log('Managed browser checks passed')
