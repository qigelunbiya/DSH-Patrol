import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const ID = /^[A-Za-z0-9._-]+$/
const BATCH_ID = /^batch-[A-Za-z0-9._-]+$/
const MAX_BATCH_RECORDS = 2000
const CONCURRENCY = 12

export function registerPatrolDashboardBatchRoutes(ctx, basePath, config = {}) {
  const prefix = `${String(basePath || '/patrol-browser-bridge').replace(/\/$/, '')}/dashboard`
  const storageRoot = resolveDashboardStorage(config)
  const disposers = []

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${prefix}/batches`,
    handler: async (req, res) => {
      if (req.method !== 'GET') return methodNotAllowed(res, ['GET'])
      try {
        const url = requestUrl(req)
        const workspace = url.searchParams.get('workspace') || ''
        const payload = await listBatchRecords(storageRoot, workspace)
        return sendJson(res, 200, { ok: true, ...payload })
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: safeError(error) })
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${prefix}/batch`,
    handler: async (req, res) => {
      if (req.method !== 'GET') return methodNotAllowed(res, ['GET'])
      try {
        const url = requestUrl(req)
        const workspace = url.searchParams.get('workspace') || ''
        const batchRunId = requireBatchId(url.searchParams.get('batchRunId'))
        const batch = await loadBatchDetail(storageRoot, workspace, batchRunId)
        return sendJson(res, 200, { ok: true, batch })
      } catch (error) {
        return sendJson(res, 404, { ok: false, error: safeError(error) })
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

function requestUrl(req) {
  return new URL(req.url || '/', 'http://127.0.0.1')
}

function requireBatchId(value) {
  if (typeof value !== 'string' || !BATCH_ID.test(value)) throw new Error('invalid batchRunId')
  return value
}

function normalizedPath(value) {
  if (typeof value !== 'string' || !value.trim()) return ''
  const full = resolve(value)
  return process.platform === 'win32' ? full.toLowerCase() : full
}

function samePath(left, right) {
  const a = normalizedPath(left)
  const b = normalizedPath(right)
  return a !== '' && a === b
}

function validateBatchState(value, batchRunId) {
  if (!value || value.schemaVersion !== 1 || value.batchRunId !== batchRunId || value.mode !== 'serial') {
    throw new Error('stored batch state is invalid')
  }
  if (!Array.isArray(value.flows) || !Array.isArray(value.results)) throw new Error('stored batch state is invalid')
  return value
}

async function readBatchState(storageRoot, batchRunId) {
  requireBatchId(batchRunId)
  const raw = await readFile(join(storageRoot, 'batches', batchRunId, 'state.json'), 'utf8')
  return validateBatchState(JSON.parse(raw), batchRunId)
}

async function readBatchSummary(storageRoot, batchRunId) {
  try {
    const raw = await readFile(join(storageRoot, 'batches', batchRunId, 'summary.json'), 'utf8')
    const value = JSON.parse(raw)
    return value && value.batchRunId === batchRunId ? value : null
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function resultFor(state, order) {
  return state.results.find(item => Number(item?.order) === order)
}

function countStatus(state, status) {
  return state.results.filter(item => item?.status === status).length
}

function batchRecordFromState(state, summary = null) {
  const totalFlows = state.flows.length
  const passedFlows = Number.isInteger(summary?.passedFlows) ? summary.passedFlows : countStatus(state, 'passed')
  const failedFlows = Number.isInteger(summary?.failedFlows) ? summary.failedFlows : countStatus(state, 'failed')
  const waitingFlows = Number.isInteger(summary?.waitingFlows) ? summary.waitingFlows : countStatus(state, 'waiting')
  const names = state.flows.map(item => String(item?.name || item?.id || '')).filter(Boolean)
  const children = state.flows.map((flow, index) => {
    const result = resultFor(state, index + 1)
    return {
      order: index + 1,
      flowId: String(flow?.id || ''),
      flowName: String(flow?.name || flow?.id || ''),
      status: result?.status || 'pending',
      ...(typeof result?.runId === 'string' ? { runId: result.runId } : {}),
      ...(typeof result?.error === 'string' ? { error: result.error } : {}),
    }
  })
  return {
    recordType: 'batch',
    recordId: state.batchRunId,
    batchRunId: state.batchRunId,
    mode: 'serial',
    concurrency: 1,
    status: state.status,
    startedAt: state.startedAt || '',
    finishedAt: state.status === 'waiting' || state.status === 'running' ? '' : (state.updatedAt || ''),
    updatedAt: state.updatedAt || '',
    totalFlows,
    passedFlows,
    failedFlows,
    waitingFlows,
    summary: `批量巡检 ${totalFlows} 个流程：${passedFlows} 通过，${failedFlows} 失败${waitingFlows ? `，${waitingFlows} 等待` : ''}`,
    flowNames: names,
    children,
  }
}

export async function listBatchRecords(storageRoot, workspace) {
  if (typeof workspace !== 'string' || !workspace.trim()) return { batches: [], truncated: false }
  const root = join(storageRoot, 'batches')
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch (error) {
    if (error?.code === 'ENOENT') return { batches: [], truncated: false }
    throw error
  }
  const ids = entries
    .filter(entry => entry.isDirectory() && BATCH_ID.test(entry.name))
    .map(entry => entry.name)
    .sort((a, b) => b.localeCompare(a))
  const selected = ids.slice(0, MAX_BATCH_RECORDS)
  const rows = await mapLimit(selected, CONCURRENCY, async batchRunId => {
    try {
      const state = await readBatchState(storageRoot, batchRunId)
      if (!samePath(state.workspaceRoot, workspace)) return null
      const summary = await readBatchSummary(storageRoot, batchRunId)
      return batchRecordFromState(state, summary)
    } catch {
      return null
    }
  })
  const batches = rows.filter(Boolean).sort((a, b) => String(b.startedAt || b.batchRunId).localeCompare(String(a.startedAt || a.batchRunId)))
  return { batches, truncated: ids.length > selected.length }
}

async function loadDefinition(storageRoot, inspectionId) {
  if (!ID.test(String(inspectionId || ''))) throw new Error('invalid inspectionId')
  const raw = await readFile(join(storageRoot, 'inspections', inspectionId, 'inspection.json'), 'utf8')
  const parsed = JSON.parse(raw)
  if (!parsed || parsed.id !== inspectionId || !Array.isArray(parsed.steps)) throw new Error('stored inspection is invalid')
  return parsed
}

export async function loadBatchDetail(storageRoot, workspace, batchRunId) {
  const state = await readBatchState(storageRoot, batchRunId)
  if (!samePath(state.workspaceRoot, workspace)) throw new Error('batch does not belong to the current workspace')
  const summary = await readBatchSummary(storageRoot, batchRunId)
  const record = batchRecordFromState(state, summary)
  const children = await mapLimit(state.flows, CONCURRENCY, async (flow, index) => {
    const result = resultFor(state, index + 1)
    let definition = null
    try { definition = await loadDefinition(storageRoot, flow.id) } catch {}
    return {
      order: index + 1,
      flowId: String(flow?.id || ''),
      flowName: String(flow?.name || flow?.id || ''),
      status: result?.status || 'pending',
      ...(typeof result?.runId === 'string' ? { runId: result.runId } : {}),
      ...(typeof result?.error === 'string' ? { error: result.error } : {}),
      targetUrl: definition?.target?.url || '',
      expectedResult: definition?.expectedResult || '',
      stepCount: Array.isArray(definition?.steps) ? definition.steps.length : 0,
    }
  })
  return { ...record, children }
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const count = Math.min(Math.max(1, limit), items.length || 1)
  await Promise.all(Array.from({ length: count }, async () => {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  }))
  return results
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
  return (error instanceof Error ? error.message : String(error || 'Patrol batch dashboard request failed')).slice(0, 300)
}
