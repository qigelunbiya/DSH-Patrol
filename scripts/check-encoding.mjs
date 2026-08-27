import { readdir, readFile } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const decoder = new TextDecoder('utf-8', { fatal: true })
const skippedDirectories = new Set(['.git', 'node_modules', '.pack-check'])
const explicitTextNames = new Set(['.gitignore', '.editorconfig', '.gitattributes', 'LICENSE'])
const textExtensions = new Set([
  '.css', '.html', '.js', '.json', '.md', '.mjs', '.ps1', '.ts', '.txt', '.yaml', '.yml',
])

// Common signatures produced when UTF-8 Chinese is decoded as GBK/CP936 and
// later written back as UTF-8. Keep these as escapes so this checker does not
// trigger on its own source.
const mojibakeMarkers = [
  '\u951f\u65a4\u62f7',
  '\u5bb8\u2103',
  '\u59af\u2033',
  '\u6d93\u64b6\u6564',
  '\u9352\u6d98\u7f13',
  '\u6960\u5c83\u7609',
  '\u7f03\u6226\u3009',
  '\u5a34\u5fda',
  '\u5bb8\u30e5\u53ff',
].map(value => JSON.parse(`"${value}"`))

const failures = []
for (const path of await collectFiles(root)) {
  const name = path.split(/[\\/]/).at(-1) ?? ''
  if (!explicitTextNames.has(name) && !textExtensions.has(extname(path).toLowerCase())) continue

  const bytes = await readFile(path)
  if (bytes.includes(0)) continue

  let text
  try {
    text = decoder.decode(bytes)
  } catch (error) {
    failures.push(`${show(path)} is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`)
    continue
  }

  if (text.includes('\uFFFD')) failures.push(`${show(path)} contains Unicode replacement characters`)
  for (const marker of mojibakeMarkers) {
    if (text.includes(marker)) failures.push(`${show(path)} contains a likely UTF-8/GBK mojibake sequence`)
  }
}

const installerPath = join(root, 'scripts', 'install-local.ps1')
const installer = decoder.decode(await readFile(installerPath))
if ([...installer].some(char => char.codePointAt(0) > 0x7f)) {
  failures.push('scripts/install-local.ps1 must remain ASCII-only so Windows PowerShell 5.1 cannot misdecode embedded Chinese literals')
}
if (!installer.includes('Copy-Item -LiteralPath $PresetSource -Destination $PresetTarget -Force')) {
  failures.push('scripts/install-local.ps1 must copy preset.yml byte-for-byte instead of recreating localized text')
}

const presetPath = join(root, 'presets', 'patrol', 'preset.yml')
const preset = decoder.decode(await readFile(presetPath))
if (!preset.includes('name: 巡检模式')) failures.push('presets/patrol/preset.yml is missing the canonical Chinese preset name')
if (!preset.includes('description: 专用于创建、验证、执行和恢复 DSH Patrol 网页巡检 Runbook；浏览器动作通过 Patrol 录制，不作为普通对话工具直接调用。')) {
  failures.push('presets/patrol/preset.yml is missing the canonical Chinese description')
}

if (failures.length > 0) {
  console.error('UTF-8 / Chinese text checks failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log('UTF-8 / Chinese text checks passed')
}

async function collectFiles(directory) {
  const out = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) out.push(...await collectFiles(path))
    else if (entry.isFile()) out.push(path)
  }
  return out
}

function show(path) {
  return relative(root, path).replaceAll('\\', '/')
}
