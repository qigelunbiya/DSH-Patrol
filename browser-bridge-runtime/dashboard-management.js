import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { compactDashboardFlow } from './safe-flow-cleanup-hardening.js'

const ID = /^[A-Za-z0-9._-]+$/
const MAX_BODY_BYTES = 32 * 1024
const WORKSPACE_OUTPUT_ROOT = 'patrol-results'
const NAMED_RUNBOOK_SUFFIX = '.flow.md'

export function registerPatrolDashboardManagementRoutes(ctx, basePath, config = {}) {
  const prefix = `${String(basePath || '/patrol-browser-bridge').replace(/\/$/, '')}/dashboard`
  const storageRoot = resolveDashboardStorage(config)
  const disposers = []

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${prefix}/flow/rename`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST'])
      try {
        const body = await readJsonBody(req)
        const inspectionId = requireId(body.inspectionId, 'inspectionId')
        const workspace = requireWorkspace(body.workspace)
        const name = requireFlowName(body.name)
        const definition = await loadDefinition(storageRoot, inspectionId)
        assertWorkspace(definition, workspace)
        definition.name = name
        definition.metadata = { ...(definition.metadata || {}), updatedAt: new Date().toISOString() }
        const persisted = await persistDefinition(storageRoot, definition)
        return sendJson(res, 200, {
          ok: true,
          inspectionId,
          name,
          updatedAt: definition.metadata.updatedAt,
          workspaceFlowFile: persisted.namedRunbook,
        })
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: safeError(error) })
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${prefix}/flow/optimize`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST'])
      try {
        const body = await readJsonBody(req)
        const inspectionId = requireId(body.inspectionId, 'inspectionId')
        const workspace = requireWorkspace(body.workspace)
        const definition = await loadDefinition(storageRoot, inspectionId)
        assertWorkspace(definition, workspace)
        const result = compactDashboardFlow(definition)
        definition.metadata = { ...(definition.metadata || {}), updatedAt: new Date().toISOString() }
        const persisted = await persistDefinition(storageRoot, definition)
        return sendJson(res, 200, {
          ok: true,
          inspectionId,
          ...result,
          updatedAt: definition.metadata.updatedAt,
          workspaceFlowFile: persisted.namedRunbook,
        })
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: safeError(error) })
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${prefix}/flow/delete`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST'])
      try {
        const body = await readJsonBody(req)
        const inspectionId = requireId(body.inspectionId, 'inspectionId')
        const workspace = requireWorkspace(body.workspace)
        if (body.confirmed !== true) throw new Error('explicit deletion confirmation is required')
        const definition = await loadDefinition(storageRoot, inspectionId)
        assertWorkspace(definition, workspace)
        const deleteHistory = body.deleteHistory !== false

        await rm(join(storageRoot, 'inspections', inspectionId), { recursive: true, force: true })
        await rm(join(storageRoot, 'resumes', `${inspectionId}.json`), { force: true })

        const workspaceFlowRoot = join(workspace, WORKSPACE_OUTPUT_ROOT, inspectionId)
        if (deleteHistory) {
          // Dashboard deletion is a real cleanup operation, not a hide flag.
          // Remove the internal history index and the complete workspace flow
          // directory so test flows do not survive in巡检记录 or on disk.
          await rm(join(storageRoot, 'runs', inspectionId), { recursive: true, force: true })
          await rm(workspaceFlowRoot, { recursive: true, force: true })
        } else {
          // API callers may explicitly preserve historical reports, while the
          // Dashboard UI defaults to full cleanup.
          await rm(join(workspaceFlowRoot, 'runbook'), { recursive: true, force: true })
          await rm(join(workspaceFlowRoot, 'teaching'), { recursive: true, force: true })
        }

        return sendJson(res, 200, {
          ok: true,
          inspectionId,
          retainedHistoricalRuns: !deleteHistory,
          deletedWorkspaceFlowRoot: deleteHistory ? workspaceFlowRoot : null,
        })
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: safeError(error) })
      }
    },
  }))

  return () => {
    for (const dispose of disposers.splice(0)) {
      try { dispose() } catch {}
    }
  }
}

function resolveDashboardStorage(config) {
  if (typeof config.storagePath === 'string' && config.storagePath.trim()) return resolve(config.storagePath)
  if (typeof config.screenshotDir === 'string' && config.screenshotDir.trim()) return resolve(dirname(config.screenshotDir))
  return resolve(process.cwd(), '.dsh-patrol')
}

function requireId(value, name) {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error(`invalid ${name}`)
  return value
}

function requireWorkspace(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('workspace is required')
  return resolve(value)
}

function requireFlowName(value) {
  if (typeof value !== 'string') throw new Error('flow name is required')
  const name = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (!name) throw new Error('flow name cannot be empty')
  if (name.length > 120) throw new Error('flow name is too long (max 120 characters)')
  return name
}

async function loadDefinition(storageRoot, id) {
  const raw = await readFile(join(storageRoot, 'inspections', id, 'inspection.json'), 'utf8')
  const parsed = JSON.parse(raw)
  if (!parsed || parsed.id !== id || !Array.isArray(parsed.steps)) throw new Error('stored inspection is invalid')
  return parsed
}

function normalizedPath(value) {
  if (typeof value !== 'string' || !value.trim()) return ''
  const full = resolve(value)
  return process.platform === 'win32' ? full.toLowerCase() : full
}

function samePath(a, b) {
  const left = normalizedPath(a)
  const right = normalizedPath(b)
  return left !== '' && left === right
}

function assertWorkspace(definition, workspace) {
  const owner = definition?.metadata?.workspaceRoot
  if (!owner || !samePath(owner, workspace)) throw new Error('inspection does not belong to the current workspace')
}

async function persistDefinition(storageRoot, definition) {
  const internal = join(storageRoot, 'inspections', definition.id, 'inspection.json')
  await atomicWrite(internal, `${JSON.stringify(definition, null, 2)}\n`)

  const workspace = definition?.metadata?.workspaceRoot
  if (typeof workspace !== 'string' || !workspace.trim()) return { namedRunbook: null }
  const runbook = join(workspace, WORKSPACE_OUTPUT_ROOT, definition.id, 'runbook')
  const markdown = renderRunbookMarkdown(definition)
  await atomicWrite(join(runbook, 'inspection.json'), `${JSON.stringify(definition, null, 2)}\n`)
  await atomicWrite(join(runbook, 'runbook.md'), markdown)
  const namedRunbook = await syncNamedRunbook(runbook, definition.name || definition.id, markdown)
  return { namedRunbook }
}

async function syncNamedRunbook(runbookRoot, name, markdown) {
  await mkdir(runbookRoot, { recursive: true })
  try {
    const entries = await readdir(runbookRoot)
    await Promise.all(entries
      .filter(entry => entry.endsWith(NAMED_RUNBOOK_SUFFIX))
      .map(entry => rm(join(runbookRoot, entry), { force: true })))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const path = join(runbookRoot, `${safeFileStem(name)}${NAMED_RUNBOOK_SUFFIX}`)
  await atomicWrite(path, markdown)
  return path
}

function safeFileStem(value) {
  const cleaned = String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 96)
  return cleaned || 'patrol-flow'
}

function renderRunbookMarkdown(definition) {
  const lines = [
    `# ${definition.name}`,
    '',
    `- Inspection ID: \`${definition.id}\``,
    `- Status: \`${definition.status}\``,
    `- Target: ${definition?.target?.url || ''}`,
    `- Expected result: ${definition.expectedResult || ''}`,
    `- Auth mode: \`${definition?.auth?.mode || 'none'}\``,
    `- Updated: ${definition?.metadata?.updatedAt || ''}`,
    '',
    '## Reusable steps',
    '',
  ]
  for (const step of definition.steps || []) {
    lines.push(`### ${step.id} ${step.name || ''}`)
    lines.push('')
    lines.push(`- Kind: \`${step.kind || ''}\``)
    if (step.tool) lines.push(`- Tool: \`${step.tool}\``)
    if (step.arguments) lines.push(`- Arguments: \`${JSON.stringify(step.arguments)}\``)
    if (step.expectation) lines.push(`- Expectation: \`${JSON.stringify(step.expectation)}\``)
    if (step.when) lines.push(`- Condition: \`${JSON.stringify(step.when)}\``)
    if (step.notes) lines.push(`- Notes: ${step.notes}`)
    lines.push('')
  }
  return `${lines.join('\n')}\n`
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  await writeFile(temporary, content, 'utf8')
  await rename(temporary, path)
}

function requestUrl(req) {
  return new URL(req.url || '/', 'http://127.0.0.1')
}

async function readJsonBody(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw.trim()) return {}
  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('request body must be a JSON object')
  return parsed
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

function methodNotAllowed(res, allow) {
  res.writeHead(405, {
    allow: allow.join(', '),
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
}

function safeError(error) {
  return (error instanceof Error ? error.message : String(error || 'Patrol dashboard request failed')).slice(0, 300)
}
