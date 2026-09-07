import { readFileSync, writeFileSync } from 'node:fs'

function replaceOnce(path, from, to) {
  const text = readFileSync(path, 'utf8')
  const first = text.indexOf(from)
  if (first < 0) throw new Error(`${path}: expected source text not found`)
  if (text.indexOf(from, first + from.length) >= 0) throw new Error(`${path}: expected source text is not unique`)
  writeFileSync(path, text.slice(0, first) + to + text.slice(first + from.length), 'utf8')
}

replaceOnce(
  'browser-bridge-runtime/dashboard-management.js',
  "import { internalPatrolWorkerPath, mountInternalPatrolWorker } from '../lib/internal-worker.js'",
  "import { internalPatrolWorkerPath, mountInternalPatrolWorker } from './internal-worker.js'",
)

writeFileSync('browser-bridge-runtime/internal-worker.js', `import { access } from 'node:fs/promises'\nimport { isAbsolute, join } from 'node:path'\n\n/** Resolve a Patrol-owned worker composition that deliberately lives outside\n * Harness's discoverable agent-preset roots. */\nexport function internalPatrolWorkerPath(root, kind) {\n  const value = String(root ?? '').trim()\n  if (!value) throw new Error('DSH Patrol internal worker root is not configured; reinstall the local Patrol integration')\n  if (!isAbsolute(value)) throw new Error(\`DSH Patrol internal worker root must be absolute: \${value}\`)\n  return join(value, \`\${kind}.cordis.yml\`)\n}\n\n/** Mount one hidden worker composition into an ephemeral scoped Agent.\n *\n * Browser runtime modules are executed directly from the source/package tree,\n * so this helper intentionally lives beside them instead of importing lib/.\n * The TypeScript Patrol shell keeps an equivalent typed helper under src/. */\nexport async function mountInternalPatrolWorker(agentCtx, compositionPath, kind) {\n  if (!isAbsolute(compositionPath)) throw new Error(\`internal Patrol worker composition must be absolute: \${compositionPath}\`)\n  await access(compositionPath)\n  const loader = agentCtx?.get?.('loader')\n  const baseUrl = loader?.config?.baseUrl\n  const importer = loader?.internal?.import\n  if (!baseUrl || typeof importer !== 'function') {\n    throw new Error('Harness Loader is unavailable; cannot mount a hidden Patrol worker composition')\n  }\n  const loaded = await Promise.resolve(importer.call(loader.internal, '@deepseek-ai/dsh-agent-presets', baseUrl, {}))\n  if (typeof loaded?.mountPreset !== 'function') {\n    throw new Error('Harness @deepseek-ai/dsh-agent-presets does not export mountPreset; update Harness before using hidden Patrol workers')\n  }\n  await loaded.mountPreset(agentCtx, {\n    id: \`dsh-patrol-internal-\${kind}\`,\n    trust: 'user',\n    path: compositionPath,\n  })\n}\n`, 'utf8')

replaceOnce(
  'scripts/check-extension.mjs',
  "for (const file of ['index.js', 'bridge.js', 'managed-browser.js', 'tools.js', 'count-tool.js', 'login-state-tool.js', 'challenge-tool.js', 'image-code.js', 'captcha-mode.js', 'captcha-demo.js', 'screenshot-ocr.js', 'tools-plugin.js', 'ws.js']) {",
  "for (const file of ['index.js', 'bridge.js', 'managed-browser.js', 'tools.js', 'count-tool.js', 'login-state-tool.js', 'challenge-tool.js', 'image-code.js', 'captcha-mode.js', 'captcha-demo.js', 'screenshot-ocr.js', 'tools-plugin.js', 'ws.js', 'internal-worker.js', 'dashboard-management.js']) {",
)

replaceOnce(
  'scripts/check-extension.mjs',
  "if (!internalWorker.includes('mountPreset')) throw new Error('hidden Patrol workers must use low-level scoped preset mounting')\nconst installer = readFileSync(join(projectRoot, 'scripts', 'install-local.ps1'), 'utf8')",
  "if (!internalWorker.includes('mountPreset')) throw new Error('hidden Patrol workers must use low-level scoped preset mounting')\nconst runtimeInternalWorker = readFileSync(join(runtimeRoot, 'internal-worker.js'), 'utf8')\nif (!runtimeInternalWorker.includes(\"'@deepseek-ai/dsh-agent-presets'\") || !runtimeInternalWorker.includes('mountPreset')) throw new Error('browser runtime hidden worker helper must use the same Harness low-level mount path')\nconst dashboardManagement = readFileSync(join(runtimeRoot, 'dashboard-management.js'), 'utf8')\nif (!dashboardManagement.includes(\"from './internal-worker.js'\")) throw new Error('dashboard runtime must use its source/package-local hidden worker helper')\nif (dashboardManagement.includes('../lib/internal-worker.js')) throw new Error('dashboard runtime must not depend on a prebuilt lib/ tree')\nconst installer = readFileSync(join(projectRoot, 'scripts', 'install-local.ps1'), 'utf8')",
)

replaceOnce(
  'tests/lazy-patrol-architecture.spec.ts',
  "const internalWorker = read('src/internal-worker.ts')",
  "const internalWorker = read('src/internal-worker.ts')\nconst runtimeInternalWorker = read('browser-bridge-runtime/internal-worker.js')\nconst dashboardManagement = read('browser-bridge-runtime/dashboard-management.js')",
)

replaceOnce(
  'tests/lazy-patrol-architecture.spec.ts',
  "    expect(internalWorker).toContain('mountPreset')\n  })",
  "    expect(internalWorker).toContain('mountPreset')\n    expect(runtimeInternalWorker).toContain(\"'@deepseek-ai/dsh-agent-presets'\")\n    expect(runtimeInternalWorker).toContain('mountPreset')\n    expect(dashboardManagement).toContain(\"from './internal-worker.js'\")\n    expect(dashboardManagement).not.toContain('../lib/internal-worker.js')\n  })",
)
