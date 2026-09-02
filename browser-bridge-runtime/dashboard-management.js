import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { compactTeachingFlow } from './flow-optimizer.js'

const ID = /^[A-Za-z0-9._-]+$/
const MAX_BODY_BYTES = 32 * 1024
const WORKSPACE_OUTPUT_ROOT = 'patrol-results'

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
        await persistDefinition(storageRoot, definition)
        return sendJson(res, 200, { ok: true, inspectionId, name, updatedAt: definition.metadata.updatedAt })
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
        const result = compactTeachingFlow(definition)
        definition.metadata = { ...(definition.metadata || {}), updatedAt: new Date().toISOString() }
        await persistDefinition(storageRoot, definition)
        return sendJson(res, 200, { ok: true, inspectionId, ...result, updatedAt: definition.metadata.updatedAt })
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

        await rm(join(storageRoot, 'inspections', inspectionId), { recursive: true, force: true })
        await rm(join(storageRoot, 'resumes', `${inspectionId}.json`), { force: true })

        // Delete the live workspace runbook and teaching-only artifacts, but
        // deliberately retain historical run reports. Stable inspection IDs are
        // not renamed because run history uses them as the foreign key.
        const workspaceFlowRoot = join(workspace, WORKSPACE_OUTPUT_ROOT, inspectionId)
        await rm(join(workspaceFlowRoot, 'runbook'), { recursive: true, force: true })
        await rm(join(workspaceFlowRoot, 'teaching'), { recursive: true, force: true })

        return sendJson(res, 200, {
          ok: true,
          inspectionId,
          retainedHistoricalRuns: true,
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
  if (typeof workspace !== 'string' || !workspace.trim()) return
  const runbook = join(workspace, WORKSPACE_OUTPUT_ROOT, definition.id, 'runbook')
  await atomicWrite(join(runbook, 'inspection.json'), `${JSON.stringify(definition, null, 2)}\n`)
  await atomicWrite(join(runbook, 'runbook.md'), renderRunbookMarkdown(definition))
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

  if (!definition.steps.length) lines.push('(no steps recorded)')
  for (const step of definition.steps) {
    lines.push(`### ${step.id} — ${step.name}`, '')
    if (step.kind === 'checkpoint') {
      lines.push(`- Kind: checkpoint`, `- Reason: ${step.reason}`, `- Prompt: ${step.prompt}`)
    } else {
      lines.push(`- Kind: tool`, `- Tool: \`${step.tool}\``, `- Arguments: \`${JSON.stringify(step.arguments)}\``)
      if (step.expectation !== undefined) lines.push(`- Expectation: ${step.expectation.mode} ${JSON.stringify(step.expectation.value)}`)
      if (step.locator !== undefined) lines.push(`- Semantic locator: \`${JSON.stringify(step.locator)}\``)
      if (step.artifact !== undefined) lines.push(`- Artifact: \`${step.artifact}\``)
    }
    if (step.when !== undefined) lines.push(`- Condition: ${step.when.sourceStepId} ${step.when.mode} ${JSON.stringify(step.when.value)}`)
    if (step.notes !== undefined) lines.push(`- Notes: ${step.notes}`)
    lines.push('')
  }
  return `${lines.join('\n')}\n`
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, content, 'utf8')
  await rename(temp, path)
}

async function readJsonBody(req) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw.trim()) return {}
  return JSON.parse(raw)
}

function methodNotAllowed(res, allow) {
  res.writeHead(405, {
    allow: allow.join(', '),
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(payload))
}

function safeError(error) {
  return error && typeof error.message === 'string' ? error.message : String(error)
}
