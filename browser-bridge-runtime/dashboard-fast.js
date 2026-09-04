import { createReadStream } from 'node:fs'
import { access, readFile, readdir, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const ID = /^[A-Za-z0-9._-]+$/
const MAX_FAST_JSON_BYTES = 512 * 1024
const MAX_RUNS_PER_INSPECTION = 2000
const CATALOG_CONCURRENCY = 12

export function registerPatrolDashboardRoutes(ctx, basePath, config = {}) {
  const prefix = `${String(basePath || '/patrol-browser-bridge').replace(/\/$/, '')}/dashboard`
  const storageRoot = resolveDashboardStorage(config)
  const disposers = []

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${prefix}/ui`,
    handler: async (req, res) => {
      if (req.method !== 'GET') return methodNotAllowed(res, ['GET'])
      const html = dashboardHtml(prefix)
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self'",
      })
      res.end(html)
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${prefix}/catalog`,
    handler: async (req, res) => {
      if (req.method !== 'GET') return methodNotAllowed(res, ['GET'])
      try {
        const url = requestUrl(req)
        const workspace = url.searchParams.get('workspace') || ''
        const payload = await buildPatrolDashboardCatalog(storageRoot, workspace)
        return sendJson(res, 200, { ok: true, ...payload })
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: safeError(error) })
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${prefix}/run`,
    handler: async (req, res) => {
      if (req.method !== 'GET') return methodNotAllowed(res, ['GET'])
      try {
        const url = requestUrl(req)
        const workspace = url.searchParams.get('workspace') || ''
        const inspectionId = requireId(url.searchParams.get('inspectionId'), 'inspectionId')
        const runId = requireId(url.searchParams.get('runId'), 'runId')
        const definition = await loadDefinition(storageRoot, inspectionId)
        assertWorkspace(definition, workspace)
        const rawReport = await loadRun(storageRoot, inspectionId, runId)
        const report = normalizeRunReport(rawReport)
        const artifacts = await describeArtifacts(storageRoot, workspace, definition, report, prefix)
        return sendJson(res, 200, { ok: true, definition, report, artifacts })
      } catch (error) {
        return sendJson(res, 404, { ok: false, error: safeError(error) })
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${prefix}/artifact`,
    handler: async (req, res) => {
      if (req.method !== 'GET') return methodNotAllowed(res, ['GET'])
      try {
        const url = requestUrl(req)
        const workspace = url.searchParams.get('workspace') || ''
        const inspectionId = requireId(url.searchParams.get('inspectionId'), 'inspectionId')
        const runId = requireId(url.searchParams.get('runId'), 'runId')
        const token = url.searchParams.get('token') || ''
        const definition = await loadDefinition(storageRoot, inspectionId)
        assertWorkspace(definition, workspace)
        const report = await loadRun(storageRoot, inspectionId, runId)
        const artifact = await resolveArtifact(storageRoot, workspace, definition, report, token)
        return streamArtifact(res, artifact)
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

function requireId(value, name) {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error(`invalid ${name}`)
  return value
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

export async function buildPatrolDashboardCatalog(storageRoot, workspace) {
  if (typeof workspace !== 'string' || !workspace.trim()) {
    return { workspace: '', inspections: [], runs: [], truncated: false }
  }

  const all = await listDefinitions(storageRoot)
  const definitions = all.filter(definition => definition?.metadata?.workspaceRoot && samePath(definition.metadata.workspaceRoot, workspace))
  const histories = await mapLimit(definitions, 4, async definition => {
    const history = await listRunSummaries(storageRoot, definition)
    return { definition, ...history }
  })

  const cards = []
  const runs = []
  let truncated = false
  for (const history of histories) {
    const summaries = history.summaries
    runs.push(...summaries)
    truncated ||= history.truncated
    cards.push({
      definition: history.definition,
      latestRun: summaries[0] || null,
      runCount: history.total,
      successCount: summaries.filter(item => item.status === 'passed').length,
      historyTruncated: history.truncated,
    })
  }

  runs.sort((a, b) => String(b.startedAt || b.runId || '').localeCompare(String(a.startedAt || a.runId || '')))
  cards.sort((a, b) => String(b.definition?.metadata?.updatedAt || '').localeCompare(String(a.definition?.metadata?.updatedAt || '')))
  return { workspace, inspections: cards, runs, truncated }
}

async function listDefinitions(storageRoot) {
  const root = join(storageRoot, 'inspections')
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const ids = entries.filter(entry => entry.isDirectory() && ID.test(entry.name)).map(entry => entry.name)
  const rows = await mapLimit(ids, CATALOG_CONCURRENCY, async id => {
    try { return await loadDefinition(storageRoot, id) } catch { return null }
  })
  return rows.filter(Boolean)
}

async function loadDefinition(storageRoot, id) {
  requireId(id, 'inspectionId')
  const raw = await readFile(join(storageRoot, 'inspections', id, 'inspection.json'), 'utf8')
  const parsed = JSON.parse(raw)
  if (!parsed || parsed.id !== id || !Array.isArray(parsed.steps)) throw new Error('stored inspection is invalid')
  return parsed
}

async function listRunSummaries(storageRoot, definition) {
  const inspectionId = definition.id
  const root = join(storageRoot, 'runs', inspectionId)
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch (error) {
    if (error?.code === 'ENOENT') return { summaries: [], total: 0, truncated: false }
    throw error
  }

  const ids = entries
    .filter(entry => entry.isDirectory() && ID.test(entry.name))
    .map(entry => entry.name)
    .sort((a, b) => b.localeCompare(a))
  const total = ids.length
  const selected = ids.slice(0, MAX_RUNS_PER_INSPECTION)
  const rows = await mapLimit(selected, CATALOG_CONCURRENCY, async runId => {
    try { return await loadRunSummary(storageRoot, definition, runId) } catch { return null }
  })
  const summaries = rows.filter(Boolean).sort((a, b) => String(b.startedAt || b.runId).localeCompare(String(a.startedAt || a.runId)))
  return { summaries, total, truncated: total > selected.length }
}

async function loadRunSummary(storageRoot, definition, runId) {
  const inspectionId = definition.id
  const runRoot = join(storageRoot, 'runs', inspectionId, runId)
  const summaryPath = join(runRoot, 'summary.json')

  try {
    const raw = await readFile(summaryPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (validSummary(parsed, inspectionId, runId)) return enrichSummary(parsed, definition, 'summary')
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      // A corrupt optional summary must never block the dashboard. Fall back to
      // the bounded legacy readers below.
    }
  }

  const jsonPath = join(runRoot, 'report.json')
  try {
    const info = await stat(jsonPath)
    if (info.isFile() && info.size <= MAX_FAST_JSON_BYTES) {
      const report = await loadRun(storageRoot, inspectionId, runId)
      return summarizeRun(report, definition, 'json')
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  try {
    const markdown = await readFile(join(runRoot, 'report.md'), 'utf8')
    return parseLegacyMarkdownSummary(markdown, definition, runId)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  // Last-resort row. This keeps one missing/corrupt historical report from
  // making the entire workspace dashboard spin forever.
  return {
    runId,
    inspectionId,
    inspectionName: definition.name || inspectionId,
    status: 'waiting',
    startedAt: runIdTimestamp(runId),
    finishedAt: '',
    summary: '历史巡检记录缺少可读取的轻量索引，点击后可尝试读取完整详情。',
    targetUrl: definition?.target?.url || '',
    expectedResult: definition?.expectedResult || '',
    stepCount: 0,
    passedSteps: 0,
    failedSteps: 0,
    artifactCount: 0,
    partial: true,
    source: 'fallback',
  }
}

function validSummary(value, inspectionId, runId) {
  return value && value.inspectionId === inspectionId && value.runId === runId
    && typeof value.status === 'string' && typeof value.startedAt === 'string'
}

function enrichSummary(value, definition, source) {
  const stepCount = safeCount(value.stepCount)
  const passedSteps = safeCount(value.passedSteps)
  const failedSteps = safeCount(value.failedSteps)
  const waitingSteps = safeCount(value.waitingSteps)
  const status = effectiveRunStatus(value.status, passedSteps, failedSteps, waitingSteps, stepCount)
  return {
    runId: value.runId,
    inspectionId: value.inspectionId,
    inspectionName: value.inspectionName || definition?.name || value.inspectionId,
    status,
    startedAt: value.startedAt || '',
    finishedAt: value.finishedAt || '',
    summary: effectiveRunSummary(value.summary, status, passedSteps),
    targetUrl: definition?.target?.url || '',
    expectedResult: value.expectedResult || definition?.expectedResult || '',
    stepCount,
    passedSteps,
    failedSteps,
    waitingSteps,
    artifactCount: safeCount(value.artifactCount),
    partial: Boolean(value.partial),
    source,
  }
}

function effectiveRunStatus(status, passedSteps, failedSteps, waitingSteps, stepCount) {
  const normalized = typeof status === 'string' && status ? status : 'waiting'
  if (normalized === 'waiting'
    && stepCount > 0
    && failedSteps === 0
    && waitingSteps === 0
    && passedSteps === stepCount) return 'passed'
  return normalized
}

function effectiveRunSummary(summary, status, passedSteps) {
  const value = typeof summary === 'string' ? summary : ''
  if (status === 'passed' && /^巡检进行中[：:]/u.test(value)) {
    return `交互巡检本轮已完成 ${passedSteps} 个步骤。`
  }
  return value || '巡检已完成，打开详情查看步骤结果。'
}

function normalizeRunReport(report) {
  const results = Array.isArray(report?.results) ? report.results : []
  const passedSteps = results.filter(result => result.status === 'passed').length
  const failedSteps = results.filter(result => result.status === 'failed').length
  const waitingSteps = results.filter(result => result.status === 'waiting').length
  const status = effectiveRunStatus(report?.status, passedSteps, failedSteps, waitingSteps, results.length)
  if (status === report?.status && !(status === 'passed' && /^巡检进行中[：:]/u.test(String(report?.summary || '')))) return report
  return { ...report, status, summary: effectiveRunSummary(report?.summary, status, passedSteps) }
}

function safeCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0
}

function summarizeRun(report, definition, source = 'json') {
  const results = Array.isArray(report.results) ? report.results : []
  const artifactCount = results.reduce((count, result) => count + (Array.isArray(result.artifacts) ? result.artifacts.length : 0), 0) + 2
  const passedSteps = results.filter(result => result.status === 'passed').length
  const failedSteps = results.filter(result => result.status === 'failed').length
  const waitingSteps = results.filter(result => result.status === 'waiting').length
  const status = effectiveRunStatus(report.status, passedSteps, failedSteps, waitingSteps, results.length)
  return {
    runId: report.runId,
    inspectionId: report.inspectionId,
    inspectionName: report.inspectionName || definition?.name || report.inspectionId,
    status,
    startedAt: report.startedAt || '',
    finishedAt: report.finishedAt || '',
    summary: effectiveRunSummary(report.summary || summarizeResults(results), status, passedSteps),
    targetUrl: definition?.target?.url || '',
    expectedResult: report.expectedResult || definition?.expectedResult || '',
    stepCount: results.length,
    passedSteps,
    failedSteps,
    waitingSteps,
    artifactCount,
    partial: false,
    source,
  }
}

export function parseLegacyMarkdownSummary(markdown, definition, runId) {
  const inspectionId = definition.id
  const header = markdown.split('\n## 步骤结果', 1)[0] || markdown
  const stepSectionIndex = markdown.indexOf('## 步骤结果')
  const steps = stepSectionIndex >= 0 ? markdown.slice(stepSectionIndex) : ''
  const status = (matchLine(header, /^- 状态：\*\*([^*]+)\*\*/m) || 'waiting').toLowerCase()
  const startedAt = matchLine(header, /^- 开始：(.+)$/m) || runIdTimestamp(runId)
  const finishedAt = matchLine(header, /^- 结束：(.+)$/m) || ''
  const expectedResult = matchLine(header, /^- 预期结果：(.+)$/m) || definition.expectedResult || ''
  const heading = matchLine(header, /^# DSH Patrol 巡检报告：(.+)$/m) || definition.name || inspectionId
  const summary = extractMarkdownSummary(markdown) || '历史巡检已通过轻量报告索引加载；打开详情可查看完整步骤输出。'
  const stepCount = (steps.match(/^### /gm) || []).length
  const passedSteps = (steps.match(/^- 状态：\*\*PASSED\*\*$/gm) || []).length
  const failedSteps = (steps.match(/^- 状态：\*\*FAILED\*\*$/gm) || []).length
  const artifactCount = (steps.match(/^- 产物（/gm) || []).length + 2
  const partial = markdown.includes('[TRUNCATED by DSH Patrol report limit]')
  return {
    runId,
    inspectionId,
    inspectionName: unescapeMarkdownHeading(heading),
    status: ['passed', 'failed', 'waiting'].includes(status) ? status : 'waiting',
    startedAt,
    finishedAt,
    summary,
    targetUrl: definition?.target?.url || '',
    expectedResult,
    stepCount,
    passedSteps,
    failedSteps,
    artifactCount,
    partial,
    source: 'markdown',
  }
}

function matchLine(text, pattern) {
  const match = pattern.exec(text)
  return match ? String(match[1] || '').trim() : ''
}

function extractMarkdownSummary(markdown) {
  const index = markdown.indexOf('## 页面摘要')
  if (index < 0) return ''
  const rest = markdown.slice(index + '## 页面摘要'.length)
  const fence = /```+text\s*\n([\s\S]*?)\n```+/m.exec(rest)
  if (fence) return String(fence[1] || '').trim().slice(0, 1200)
  const next = rest.indexOf('\n## ')
  return (next >= 0 ? rest.slice(0, next) : rest).replace(/```+\w*/g, '').trim().slice(0, 1200)
}

function unescapeMarkdownHeading(value) {
  return String(value || '').replace(/\\([\\`*_{}\[\]()#+.!|>~-])/g, '$1')
}

function runIdTimestamp(runId) {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)/.exec(runId)
  if (!match) return ''
  const raw = match[1]
  return `${raw.slice(0, 13)}:${raw.slice(14, 16)}:${raw.slice(17, 19)}.${raw.slice(20, 23)}Z`
}

function summarizeResults(results) {
  const failed = results.find(result => result.status === 'failed')
  if (failed) return `${failed.name || failed.stepId || '步骤'}失败${failed.error ? `：${String(failed.error).slice(0, 120)}` : ''}`
  if (results.length === 0) return '尚未产生步骤结果'
  const passed = results.filter(result => result.status === 'passed').length
  return `完成 ${passed}/${results.length} 个步骤`
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

async function loadRun(storageRoot, inspectionId, runId) {
  requireId(inspectionId, 'inspectionId')
  requireId(runId, 'runId')
  const raw = await readFile(join(storageRoot, 'runs', inspectionId, runId, 'report.json'), 'utf8')
  const parsed = JSON.parse(raw)
  if (!parsed || parsed.inspectionId !== inspectionId || parsed.runId !== runId || !Array.isArray(parsed.results)) {
    throw new Error('stored run report is invalid')
  }
  return parsed
}

async function describeArtifacts(storageRoot, workspace, definition, report, prefix) {
  const rows = await artifactCandidates(storageRoot, workspace, report)
  const described = []
  for (const row of rows) {
    try {
      const file = await safeArtifactPath(storageRoot, workspace, definition, report, row.path)
      const info = await stat(file)
      if (!info.isFile()) continue
      described.push({
        token: row.token,
        kind: row.kind,
        name: row.name,
        stepId: row.stepId || null,
        size: info.size,
        mime: mimeType(file),
        preview: previewKind(file),
        url: `${prefix}/artifact?workspace=${encodeURIComponent(workspace)}&inspectionId=${encodeURIComponent(report.inspectionId)}&runId=${encodeURIComponent(report.runId)}&token=${encodeURIComponent(row.token)}`,
      })
    } catch {}
  }
  return described
}

async function artifactCandidates(storageRoot, workspace, report) {
  const runRoot = join(storageRoot, 'runs', report.inspectionId, report.runId)
  const rows = [
    { token: 'report-json', kind: 'json-report', name: '巡检报告.json', path: join(runRoot, 'report.json') },
    { token: 'report-markdown', kind: 'markdown-report', name: '巡检报告.md', path: join(runRoot, 'report.md') },
  ]
  let index = 0
  for (const result of Array.isArray(report.results) ? report.results : []) {
    for (const artifact of Array.isArray(result.artifacts) ? result.artifacts : []) {
      if (!artifact || typeof artifact.path !== 'string') continue
      rows.push({ token: `step-${index++}`, kind: artifact.kind || 'artifact', name: basename(artifact.path), path: artifact.path, stepId: result.stepId })
    }
  }
  const known = new Set(rows.map(row => normalizedPath(row.path)).filter(Boolean))
  for (const legacy of await discoverLegacyTeachingScreenshots(workspace, report)) {
    if (known.has(normalizedPath(legacy.path))) continue
    rows.push({ token: `legacy-screenshot-${index++}`, kind: 'screenshot', name: basename(legacy.path), path: legacy.path, stepId: null })
  }
  return rows
}

export async function discoverLegacyTeachingScreenshots(workspace, report) {
  if (typeof workspace !== 'string' || !workspace.trim()) return []
  if (!report || typeof report.runId !== 'string' || !report.runId.startsWith('teaching-')) return []
  if (typeof report.inspectionId !== 'string' || !ID.test(report.inspectionId)) return []
  const root = join(workspace, 'patrol-results', report.inspectionId, 'teaching', 'screenshots')
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const started = Date.parse(String(report.startedAt || ''))
  const finished = Date.parse(String(report.finishedAt || report.startedAt || ''))
  const lower = Number.isFinite(started) ? started - 120_000 : Number.NEGATIVE_INFINITY
  const upper = Number.isFinite(finished) ? finished + 120_000 : Number.POSITIVE_INFINITY
  const rows = []
  for (const entry of entries) {
    if (!entry.isFile() || !['.png', '.jpg', '.jpeg', '.webp'].includes(extname(entry.name).toLowerCase())) continue
    const path = join(root, entry.name)
    try {
      const info = await stat(path)
      if (info.mtimeMs < lower || info.mtimeMs > upper) continue
      rows.push({ path, mtimeMs: info.mtimeMs })
    } catch {}
  }
  rows.sort((a, b) => a.mtimeMs - b.mtimeMs)
  return rows
}

async function resolveArtifact(storageRoot, workspace, definition, report, token) {
  const row = (await artifactCandidates(storageRoot, workspace, report)).find(item => item.token === token)
  if (!row) throw new Error('artifact not found')
  const path = await safeArtifactPath(storageRoot, workspace, definition, report, row.path)
  await access(path)
  return { ...row, path, mime: mimeType(path) }
}

async function safeArtifactPath(storageRoot, workspace, definition, report, path) {
  if (typeof path !== 'string' || !path.trim()) throw new Error('artifact path is invalid')
  const candidate = resolve(path)
  const allowed = [storageRoot, workspace, definition?.metadata?.workspaceRoot, report?.outputWorkspace]
    .filter(value => typeof value === 'string' && value.trim())
    .map(value => resolve(value))
  if (!allowed.some(root => isWithin(root, candidate))) throw new Error('artifact path is outside Patrol workspace roots')
  return candidate
}

function isWithin(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function mimeType(path) {
  switch (extname(path).toLowerCase()) {
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.json': return 'application/json; charset=utf-8'
    case '.md': return 'text/markdown; charset=utf-8'
    case '.txt': return 'text/plain; charset=utf-8'
    case '.csv': return 'text/csv; charset=utf-8'
    default: return 'application/octet-stream'
  }
}

function previewKind(path) {
  const ext = extname(path).toLowerCase()
  if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) return 'image'
  if (['.json', '.md', '.txt', '.csv'].includes(ext)) return 'text'
  return 'download'
}

function streamArtifact(res, artifact) {
  res.writeHead(200, {
    'content-type': artifact.mime,
    'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(artifact.name || basename(artifact.path))}`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  const stream = createReadStream(artifact.path)
  stream.on('error', () => {
    if (!res.headersSent) sendJson(res, 404, { ok: false, error: 'artifact unavailable' })
    else res.destroy()
  })
  stream.pipe(res)
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

function dashboardHtml(prefix) {
  const api = JSON.stringify(prefix)
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH Patrol</title>
<style>
:root{color-scheme:light;--bg:#f6f8fb;--surface:#fff;--text:#172033;--muted:#667085;--line:#e5e9f0;--primary:#2563eb;--pale:#eff6ff;--success:#087a55;--successbg:#ecfdf3;--danger:#c43225;--dangerbg:#fef3f2;--warn:#a15c09;--warnbg:#fffaeb;--shadow:0 8px 30px rgba(15,23,42,.055)}
*{box-sizing:border-box}html,body{margin:0;min-height:100%;font-family:Inter,"PingFang SC","Microsoft YaHei",system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--text);background:var(--bg)}button,input,select{font:inherit}.app{padding:22px 26px 38px}.page{max-width:1380px;margin:auto}.top{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:18px}.eyebrow{font-size:11px;font-weight:750;letter-spacing:.08em;color:var(--primary);margin-bottom:6px}.title{font-size:23px;margin:0}.sub{color:var(--muted);font-size:13px;line-height:1.6;margin-top:6px}.actions{display:flex;gap:8px;flex-wrap:wrap}.btn{height:36px;border:1px solid var(--line);border-radius:10px;background:#fff;color:var(--text);padding:0 13px;font-size:13px;font-weight:650;cursor:pointer}.btn:hover{border-color:#c8d2e1}.card{background:var(--surface);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow)}.panel{padding:18px}.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:11px;margin:12px 0 20px}.stat{background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px 16px}.stat span,.muted{color:var(--muted)}.stat span{font-size:12px}.stat b{display:block;font-size:20px;margin-top:5px}.pill{display:inline-flex;align-items:center;gap:6px;padding:4px 9px;border-radius:999px;background:#f2f4f7;color:#475467;font-size:12px;font-weight:700}.pill:before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}.pill.passed,.pill.ready{background:var(--successbg);color:var(--success)}.pill.failed{background:var(--dangerbg);color:var(--danger)}.pill.waiting,.pill.draft{background:var(--warnbg);color:var(--warn)}.flow-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(285px,1fr));gap:14px}.flow-card{padding:18px;cursor:pointer;min-height:190px;display:flex;flex-direction:column;transition:.16s ease}.flow-card:hover{transform:translateY(-2px);border-color:#c9d6eb;box-shadow:0 14px 34px rgba(37,99,235,.08)}.flow-icon{width:42px;height:42px;border-radius:12px;background:var(--pale);color:var(--primary);display:grid;place-items:center;font-weight:800;margin-bottom:13px}.flow-name{font-size:16px;font-weight:750}.flow-desc{font-size:13px;line-height:1.55;color:var(--muted);margin:7px 0 11px;min-height:40px}.flow-meta{border-top:1px solid var(--line);padding-top:12px;margin-top:auto;display:flex;justify-content:space-between;gap:8px;color:var(--muted);font-size:12px}.hero{padding:22px;margin-bottom:14px;background:linear-gradient(135deg,#fff,#f7faff)}.hero h2{font-size:22px;margin:8px 0}.hero p{color:var(--muted);line-height:1.7;margin:0}.meta-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:17px}.meta{border:1px solid var(--line);border-radius:11px;padding:11px 13px;background:rgba(255,255,255,.85)}.meta label{display:block;color:var(--muted);font-size:11px;margin-bottom:5px}.meta div{font-size:13px;font-weight:620;word-break:break-word}.detail-grid{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(260px,.55fr);gap:14px}.section-title{font-size:15px;font-weight:750;margin:0 0 13px}.steps{position:relative}.step{display:grid;grid-template-columns:34px 1fr;gap:12px;padding-bottom:13px;position:relative}.step:not(:last-child):before{content:"";position:absolute;left:16px;top:32px;bottom:-2px;width:2px;background:#e4e9f2}.num{width:34px;height:34px;border-radius:50%;border:2px solid #a7c5f7;color:var(--primary);background:#f7faff;display:grid;place-items:center;font-size:12px;font-weight:750;z-index:1}.node{border:1px solid var(--line);border-radius:12px;padding:12px 14px;background:#fff}.node summary{cursor:pointer;list-style:none}.node-name{font-size:13px;font-weight:720}.chip{display:inline-flex;background:#f2f4f7;color:#475467;font-size:11px;padding:3px 7px;border-radius:7px;margin:7px 5px 0 0}.toolbar{display:grid;grid-template-columns:minmax(220px,1fr) 160px 180px auto;gap:10px;margin-bottom:12px}.control{height:38px;border:1px solid var(--line);border-radius:10px;background:#fff;padding:0 11px;outline:none}.table-wrap{overflow:auto}.table{width:100%;border-collapse:collapse;font-size:13px}.table th{background:#f8fafc;color:#667085;font-size:11px;text-align:left;padding:11px 13px;white-space:nowrap;border-bottom:1px solid var(--line)}.table td{padding:12px 13px;border-bottom:1px solid #edf0f4;vertical-align:middle}.table tbody tr{cursor:pointer}.table tbody tr:hover{background:#fafcff}.summary{max-width:390px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#475467}.tiny{font-size:11px}.tabs{display:flex;gap:4px;border-bottom:1px solid var(--line);margin-bottom:14px}.tab{border:0;background:transparent;padding:10px 13px;color:var(--muted);font-size:13px;font-weight:680;border-bottom:2px solid transparent;cursor:pointer}.tab.active{color:var(--primary);border-bottom-color:var(--primary)}.timeline .row{display:grid;grid-template-columns:18px 1fr;gap:12px;position:relative;padding-bottom:14px}.timeline .row:not(:last-child):before{content:"";position:absolute;left:8px;top:18px;bottom:-2px;width:1px;background:var(--line)}.dot{width:17px;height:17px;border-radius:50%;border:4px solid #d0d5dd;background:#fff;z-index:1}.row.passed .dot{border-color:#6ce0b0}.row.failed .dot{border-color:#fda29b}.runbox{border:1px solid var(--line);border-radius:11px;padding:12px 14px;background:#fff}.output{white-space:pre-wrap;max-height:110px;overflow:hidden;color:#475467;font-size:12px;line-height:1.6;margin-top:8px}.artifact-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(225px,1fr));gap:12px}.artifact{overflow:hidden}.preview{height:130px;background:#f2f4f7;display:grid;place-items:center;border-bottom:1px solid var(--line)}.preview img{width:100%;height:100%;object-fit:cover}.artifact-info{padding:12px}.log{border:1px solid var(--line);border-radius:11px;background:#fff;margin-bottom:9px;overflow:hidden}.log summary{padding:12px 14px;cursor:pointer;font-weight:680;display:flex;justify-content:space-between}.code{margin:0;border-top:1px solid var(--line);background:#0f172a;color:#dbeafe;padding:14px;white-space:pre-wrap;word-break:break-word;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;max-height:360px;overflow:auto}.loading{height:55vh;display:grid;place-items:center;color:var(--muted)}.spinner{width:24px;height:24px;border:3px solid #dbe4f2;border-top-color:var(--primary);border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 10px}@keyframes spin{to{transform:rotate(360deg)}}.empty{text-align:center;padding:54px 20px}.notice{padding:10px 13px;border:1px solid #f2d49b;background:#fffbeb;color:#8a4b08;border-radius:10px;font-size:12px;margin-bottom:12px}.modal-bg{position:fixed;inset:0;background:rgba(15,23,42,.5);display:grid;place-items:center;padding:28px;z-index:20}.modal{width:min(1000px,96vw);max-height:90vh;overflow:auto;background:#fff;border-radius:16px}.modal-head{position:sticky;top:0;background:#fff;border-bottom:1px solid var(--line);padding:13px 16px;display:flex;justify-content:space-between;align-items:center}.modal-body{padding:16px}.modal-body img{max-width:100%;display:block;margin:auto;border-radius:10px}
@media(max-width:900px){.app{padding:17px}.stats{grid-template-columns:repeat(2,1fr)}.meta-grid,.detail-grid{grid-template-columns:1fr}.toolbar{grid-template-columns:1fr 1fr}.toolbar input{grid-column:1/-1}.top{flex-direction:column}}
</style>
</head>
<body><main class="app"><div id="root" class="page"><div class="loading"><div><div class="spinner"></div>正在读取巡检数据…</div></div></div></main>
<script>
const API=${api};
const qs=new URLSearchParams(location.search),MODE=qs.get('mode')==='records'?'records':'flows',WORKSPACE=qs.get('workspace')||'',CURRENT=qs.get('current')||'';
const root=document.getElementById('root');let catalog=null,selectedFlow=CURRENT,selectedRun=null,runDetail=null,detailTab='overview';
const esc=v=>String(v??'').replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]));
const fmt=t=>{if(!t)return'—';const d=new Date(t);return Number.isNaN(d.getTime())?esc(t):d.toLocaleString('zh-CN',{hour12:false})};
const dur=(a,b)=>{const x=new Date(a).getTime(),y=new Date(b).getTime();if(!Number.isFinite(x)||!Number.isFinite(y)||y<x)return'—';const s=(y-x)/1000;return s<60?s.toFixed(1)+' 秒':Math.floor(s/60)+' 分 '+Math.round(s%60)+' 秒'};
const pill=s=>'<span class="pill '+esc(s)+'">'+({passed:'通过',failed:'失败',waiting:'等待中',ready:'已就绪',draft:'草稿'}[s]||esc(s||'未知'))+'</span>';
const host=u=>{try{return new URL(u).host}catch{return u||'—'}};
function empty(t,s){return '<div class="card empty"><div style="font-weight:720">'+esc(t)+'</div><div class="muted" style="font-size:12px;margin-top:7px">'+esc(s||'')+'</div></div>'}
function header(t,s,a=''){return '<div class="top"><div><div class="eyebrow">DSH PATROL</div><h1 class="title">'+esc(t)+'</h1><div class="sub">'+esc(s)+'</div></div><div class="actions">'+a+'</div></div>'}
async function get(path,timeout=12000){const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),timeout);try{const r=await fetch(API+path,{cache:'no-store',credentials:'same-origin',signal:ctl.signal});const p=await r.json();if(!r.ok||p.ok!==true)throw new Error(p.error||'请求失败');return p}catch(e){if(e&&e.name==='AbortError')throw new Error('读取巡检数据超时。请确认 Patrol Host 已更新并重新启动。');throw e}finally{clearTimeout(timer)}}
async function boot(){try{catalog=await get('/catalog?workspace='+encodeURIComponent(WORKSPACE));render()}catch(e){root.innerHTML=header('巡检数据读取失败','Dashboard Host 没有在限定时间内返回数据。')+empty('无法读取巡检数据',e.message)}}
function notice(){return catalog?.truncated?'<div class="notice">当前工作区历史记录很多，为保证页面秒开，每个流程最多加载最近 2000 条记录；流程总运行次数仍显示真实数量。</div>':''}
function render(){if(!WORKSPACE){root.innerHTML=header(MODE==='flows'?'流程管理':'巡检记录','当前会话没有可识别的工作区路径。')+empty('暂无工作区','请从已打开工作区的巡检会话进入。');return}MODE==='flows'?renderFlows():renderRecords()}
function renderFlows(){const cards=catalog.inspections||[],current=cards.find(x=>x.definition.id===selectedFlow);if(current)return renderFlowDetail(current);const runs=catalog.runs||[],ok=runs.filter(x=>x.status==='passed').length;root.innerHTML=header('流程管理','集中管理当前工作区的巡检流程，点击卡片查看流程图和历史运行。','<button class="btn" onclick="refresh()">↻ 刷新</button>')+notice()+'<div class="stats"><div class="stat"><span>流程总数</span><b>'+cards.length+'</b></div><div class="stat"><span>已就绪</span><b>'+cards.filter(x=>x.definition.status==='ready').length+'</b></div><div class="stat"><span>已加载巡检</span><b>'+runs.length+'</b></div><div class="stat"><span>通过记录</span><b>'+ok+'</b></div></div>'+(cards.length?'<div class="flow-grid">'+cards.map(flowCard).join('')+'</div>':empty('还没有流程','保存第一个巡检流程后，这里会自动出现。'))}
function flowCard(x){const d=x.definition,l=x.latestRun;return '<article class="card flow-card" onclick="openFlow(\''+esc(d.id)+'\')"><div class="flow-icon">'+esc(String((d.name||d.id).trim().charAt(0)||'流').toUpperCase())+'</div><div style="display:flex;justify-content:space-between;gap:9px"><div class="flow-name">'+esc(d.name||d.id)+'</div>'+pill(d.status)+'</div><div class="flow-desc">'+esc(d.description||'暂无流程说明')+'</div><div class="tiny muted">'+esc(host(d.target?.url||''))+'</div><div class="flow-meta"><span>'+((d.steps||[]).length)+' 个步骤 · '+x.runCount+' 次运行</span><span>'+(l?fmt(l.startedAt):'尚未运行')+'</span></div></article>'}
function openFlow(id){selectedFlow=id;renderFlows();scrollTo(0,0)}function closeFlow(){selectedFlow='';renderFlows();scrollTo(0,0)}
function renderFlowDetail(x){const d=x.definition,l=x.latestRun;root.innerHTML=header('流程详情','默认展示当前会话使用的流程，可返回查看当前工作区全部流程。','<button class="btn" onclick="closeFlow()">← 返回全部流程</button><button class="btn" onclick="refresh()">↻ 刷新</button>')+notice()+'<section class="card hero"><div>'+pill(d.status)+' <span class="tiny muted">'+esc(d.id)+'</span></div><h2>'+esc(d.name||d.id)+'</h2><p>'+esc(d.description||'暂无流程说明')+'</p><div class="meta-grid">'+meta('目标地址',d.target?.url||'—')+meta('预期结果',d.expectedResult||'—')+meta('最近更新',fmt(d.metadata?.updatedAt))+meta('步骤数量',String((d.steps||[]).length)+' 个')+meta('认证方式',d.auth?.mode||'none')+meta('最近运行',l?fmt(l.startedAt):'尚未运行')+'</div></section><div class="detail-grid"><section class="card panel"><h3 class="section-title">流程图</h3><div class="steps">'+diagram(d.steps||[])+'</div></section><section class="card panel"><h3 class="section-title">流程信息</h3>'+info('产物类型',(d.artifacts||[]).join('、')||'未指定')+info('计划任务',d.schedule?.enabled?(d.schedule.cron||'已启用'):'未启用')+info('工作区',d.metadata?.workspaceRoot||'—')+info('最近验证',fmt(d.metadata?.validatedAt))+'</section></div>'+recentRuns(x)}
function meta(a,b){return '<div class="meta"><label>'+esc(a)+'</label><div>'+esc(b)+'</div></div>'}function info(a,b){return '<div style="padding:10px 0;border-bottom:1px solid var(--line)"><div class="tiny muted">'+esc(a)+'</div><div style="font-size:13px;font-weight:620;margin-top:4px;word-break:break-word">'+esc(b)+'</div></div>'}
function diagram(steps){if(!steps.length)return empty('暂无步骤','该流程还没有可复用步骤。');return steps.map((s,i)=>'<div class="step"><div class="num">'+(i+1)+'</div><details class="node"><summary><div style="display:flex;justify-content:space-between;gap:10px"><div><div class="node-name">'+esc(s.name||s.id)+'</div><div class="tiny muted" style="margin-top:4px">'+esc(s.kind==='checkpoint'?'人工确认':s.tool||'自动步骤')+'</div></div><span class="chip">'+(s.kind==='checkpoint'?'检查点':'自动执行')+'</span></div></summary>'+(s.notes?'<div class="muted" style="font-size:12px;line-height:1.55;margin-top:8px">'+esc(s.notes)+'</div>':'')+(s.expectation?'<span class="chip">校验 '+esc(s.expectation.mode)+'</span>':'')+(s.when?'<span class="chip">条件分支</span>':'')+(s.artifact?'<span class="chip">产物 '+esc(s.artifact)+'</span>':'')+'</details></div>').join('')}
function recentRuns(x){const rows=(catalog.runs||[]).filter(r=>r.inspectionId===x.definition.id).slice(0,5);return '<section class="card panel" style="margin-top:14px"><div style="display:flex;justify-content:space-between"><h3 class="section-title">最近巡检</h3><span class="tiny muted">共 '+x.runCount+' 次</span></div>'+(rows.length?'<div class="table-wrap"><table class="table"><thead><tr><th>时间</th><th>状态</th><th>概述</th><th>步骤</th><th>耗时</th></tr></thead><tbody>'+rows.map(r=>'<tr onclick="openRun(\''+esc(r.inspectionId)+'\',\''+esc(r.runId)+'\')"><td>'+fmt(r.startedAt)+'</td><td>'+pill(r.status)+'</td><td class="summary">'+esc(r.summary||'—')+'</td><td>'+r.passedSteps+'/'+r.stepCount+'</td><td>'+dur(r.startedAt,r.finishedAt)+'</td></tr>').join('')+'</tbody></table></div>':'<div class="muted" style="font-size:12px">还没有历史运行。</div>')+'</section>'}
function renderRecords(){if(selectedRun&&runDetail)return renderRunDetail();const runs=catalog.runs||[];root.innerHTML=header('巡检记录','一条记录代表一次完整巡检。支持搜索、筛选、排序，点击查看概述、步骤、产物和日志。','<button class="btn" onclick="refresh()">↻ 刷新</button>')+notice()+'<div class="stats"><div class="stat"><span>已加载记录</span><b>'+runs.length+'</b></div><div class="stat"><span>通过</span><b>'+runs.filter(x=>x.status==='passed').length+'</b></div><div class="stat"><span>失败</span><b>'+runs.filter(x=>x.status==='failed').length+'</b></div><div class="stat"><span>等待处理</span><b>'+runs.filter(x=>x.status==='waiting').length+'</b></div></div><div class="toolbar"><input id="search" class="control" placeholder="搜索流程、概述、目标地址…" oninput="filterRecords()"><select id="status" class="control" onchange="filterRecords()"><option value="all">全部状态</option><option value="passed">通过</option><option value="failed">失败</option><option value="waiting">等待中</option></select><select id="sort" class="control" onchange="filterRecords()"><option value="new">时间：最新优先</option><option value="old">时间：最早优先</option><option value="name">流程名称</option></select><div class="muted" style="font-size:12px;align-self:center;text-align:right"><span id="count">'+runs.length+'</span> 条</div></div><section class="card table-wrap"><table class="table"><thead><tr><th>巡检时间</th><th>流程</th><th>状态</th><th>概述</th><th>目标</th><th>步骤</th><th>产物</th><th>耗时</th></tr></thead><tbody id="records-body"></tbody></table><div id="records-empty"></div></section>';filterRecords()}
function filterRecords(){const q=(document.getElementById('search')?.value||'').trim().toLowerCase(),s=document.getElementById('status')?.value||'all',sort=document.getElementById('sort')?.value||'new';let rows=(catalog.runs||[]).filter(r=>(s==='all'||r.status===s)&&(!q||[r.inspectionName,r.summary,r.targetUrl,r.inspectionId].join(' ').toLowerCase().includes(q)));rows=rows.slice().sort((a,b)=>sort==='old'?String(a.startedAt).localeCompare(String(b.startedAt)):sort==='name'?String(a.inspectionName).localeCompare(String(b.inspectionName),'zh-CN'):String(b.startedAt).localeCompare(String(a.startedAt)));const body=document.getElementById('records-body');if(!body)return;body.innerHTML=rows.map(recordRow).join('');document.getElementById('count').textContent=rows.length;document.getElementById('records-empty').innerHTML=rows.length?'':empty('没有匹配的巡检记录','调整关键词或状态后再试。')}
function recordRow(r){return '<tr onclick="openRun(\''+esc(r.inspectionId)+'\',\''+esc(r.runId)+'\')"><td style="white-space:nowrap">'+fmt(r.startedAt)+'</td><td><b>'+esc(r.inspectionName)+'</b><div class="tiny muted">'+esc(r.inspectionId)+'</div></td><td>'+pill(r.status)+'</td><td class="summary" title="'+esc(r.summary||'')+'">'+esc(r.summary||'—')+(r.partial?' <span class="tiny muted">(轻量索引)</span>':'')+'</td><td>'+esc(host(r.targetUrl))+'</td><td>'+r.passedSteps+'/'+r.stepCount+'</td><td>'+r.artifactCount+'</td><td>'+dur(r.startedAt,r.finishedAt)+'</td></tr>'}
async function openRun(inspectionId,runId){selectedRun={inspectionId,runId};root.innerHTML='<div class="loading"><div><div class="spinner"></div>正在读取巡检详情…</div></div>';try{runDetail=await get('/run?workspace='+encodeURIComponent(WORKSPACE)+'&inspectionId='+encodeURIComponent(inspectionId)+'&runId='+encodeURIComponent(runId),20000);detailTab='overview';renderRunDetail()}catch(e){selectedRun=null;runDetail=null;root.innerHTML=header('巡检详情读取失败','完整历史报告可能很大。')+empty('无法读取巡检详情',e.message)}}
function closeRun(){selectedRun=null;runDetail=null;detailTab='overview';MODE==='flows'?renderFlows():renderRecords();scrollTo(0,0)}function setTab(t){detailTab=t;renderRunDetail()}
function renderRunDetail(){const r=runDetail.report,d=runDetail.definition,a=runDetail.artifacts||[];root.innerHTML=header('巡检详情',r.inspectionName||d.name||r.inspectionId,'<button class="btn" onclick="closeRun()">← 返回</button>')+'<section class="card hero"><div>'+pill(r.status)+'</div><h2>'+esc(r.inspectionName||d.name)+'</h2><p>'+esc(r.summary||'本次巡检已完成，详细信息见下方。')+'</p><div class="tiny muted" style="margin-top:10px">'+fmt(r.startedAt)+' · '+dur(r.startedAt,r.finishedAt)+'</div></section><div class="tabs">'+[['overview','概述'],['steps','步骤'],['artifacts','产物'],['logs','日志']].map(x=>'<button class="tab '+(detailTab===x[0]?'active':'')+'" onclick="setTab(\''+x[0]+'\')">'+x[1]+'</button>').join('')+'</div>'+detailContent(r,d,a)}
function detailContent(r,d,a){if(detailTab==='steps')return stepsView(r);if(detailTab==='artifacts')return artifactsView(a);if(detailTab==='logs')return logsView(r,d);const rows=r.results||[],passed=rows.filter(x=>x.status==='passed').length;return '<div class="detail-grid"><section class="card panel"><h3 class="section-title">本次巡检概述</h3><div style="line-height:1.75;font-size:13px">'+esc(r.summary||'没有额外摘要。')+'</div><div class="muted" style="font-size:12px;margin-top:12px">步骤完成 '+passed+'/'+rows.length+'</div></section><section class="card panel"><h3 class="section-title">关键信息</h3>'+info('目标地址',d.target?.url||'—')+info('预期结果',r.expectedResult||d.expectedResult||'—')+info('开始时间',fmt(r.startedAt))+info('结束时间',fmt(r.finishedAt))+info('产物数量',String(a.length))+'</section></div>'}
function stepsView(r){const rows=r.results||[];if(!rows.length)return empty('暂无步骤结果','本次巡检没有可展示的步骤记录。');return '<section class="card panel"><div class="timeline">'+rows.map(x=>'<div class="row '+esc(x.status)+'"><div class="dot"></div><div class="runbox"><div style="display:flex;justify-content:space-between;gap:10px"><div><b>'+esc(x.name||x.stepId)+'</b><div class="tiny muted">'+esc(x.tool||x.kind||'步骤')+'</div></div>'+pill(x.status)+'</div><div class="tiny muted" style="margin-top:7px">'+fmt(x.startedAt)+' · '+dur(x.startedAt,x.finishedAt)+'</div>'+(x.error?'<div class="output" style="color:var(--danger)">'+esc(x.error)+'</div>':x.output?'<div class="output">'+esc(x.output)+'</div>':'')+'</div></div>').join('')+'</div></section>'}
function artifactsView(a){if(!a.length)return empty('暂无产物','本次巡检没有保存可预览产物。');return '<div class="artifact-grid">'+a.map(x=>'<article class="card artifact"><div class="preview">'+(x.preview==='image'?'<img loading="lazy" src="'+esc(x.url)+'" alt="'+esc(x.name)+'">':'<div style="font-size:28px">▤</div>')+'</div><div class="artifact-info"><b>'+esc(x.name)+'</b><div class="tiny muted" style="margin-top:4px">'+esc(x.kind)+' · '+bytes(x.size)+'</div><button class="btn" style="margin-top:10px" onclick="previewArtifact(event,\''+esc(x.token)+'\')">'+(x.preview==='download'?'打开':'预览')+'</button></div></article>').join('')+'</div>'}
function logsView(r,d){const byId=new Map((d.steps||[]).map(x=>[x.id,x]));return (r.results||[]).map(x=>{const def=byId.get(x.stepId)||{};return '<details class="log"><summary><span>'+esc(x.name||x.stepId)+'</span>'+pill(x.status)+'</summary><pre class="code">工具: '+esc(x.tool||def.tool||x.kind||'')+'\n\n参数:\n'+esc(JSON.stringify(def.arguments||{},null,2))+'\n\n输出:\n'+esc(x.output||'')+(x.error?'\n\n错误:\n'+esc(x.error):'')+'</pre></details>'}).join('')||empty('暂无日志','本次巡检没有步骤日志。')}
function bytes(n){if(!Number.isFinite(n))return'—';if(n<1024)return n+' B';if(n<1048576)return(n/1024).toFixed(1)+' KB';return(n/1048576).toFixed(1)+' MB'}
async function previewArtifact(ev,token){ev.stopPropagation();const a=(runDetail.artifacts||[]).find(x=>x.token===token);if(!a)return;if(a.preview==='download'){open(a.url,'_blank','noopener');return}document.body.insertAdjacentHTML('beforeend','<div id="artifact-modal" class="modal-bg" onclick="if(event.target===this)this.remove()"><div class="modal"><div class="modal-head"><b>'+esc(a.name)+'</b><button class="btn" onclick="document.getElementById(\'artifact-modal\').remove()">关闭</button></div><div id="modal-body" class="modal-body"><div class="loading" style="height:180px">正在加载…</div></div></div></div>');const body=document.getElementById('modal-body');if(a.preview==='image'){body.innerHTML='<img src="'+esc(a.url)+'" alt="'+esc(a.name)+'">';return}try{const r=await fetch(a.url,{cache:'no-store'});let text=await r.text();if(a.mime?.startsWith('application/json'))try{text=JSON.stringify(JSON.parse(text),null,2)}catch{}body.innerHTML='<pre class="code" style="border-radius:10px;max-height:70vh">'+esc(text)+'</pre>'}catch(e){body.innerHTML=empty('预览失败',e.message)}}
async function refresh(){selectedRun=null;runDetail=null;root.innerHTML='<div class="loading"><div><div class="spinner"></div>正在刷新…</div></div>';try{catalog=await get('/catalog?workspace='+encodeURIComponent(WORKSPACE));render()}catch(e){root.innerHTML=header('刷新失败','Dashboard Host 没有及时返回数据。')+empty('无法刷新',e.message)}}
boot();
</script></body></html>`
}
