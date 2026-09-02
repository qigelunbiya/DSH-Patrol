import { createReadStream } from 'node:fs'
import { access, readFile, readdir, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const ID = /^[A-Za-z0-9._-]+$/

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
        const payload = await buildCatalog(storageRoot, workspace)
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
        const report = await loadRun(storageRoot, inspectionId, runId)
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

async function buildCatalog(storageRoot, workspace) {
  if (!workspace.trim()) return { workspace: '', inspections: [], runs: [] }
  const all = await listDefinitions(storageRoot)
  const inspections = all.filter(definition => definition?.metadata?.workspaceRoot && samePath(definition.metadata.workspaceRoot, workspace))
  const runs = []
  const cards = []
  for (const definition of inspections) {
    const history = await listRuns(storageRoot, definition.id)
    const summaries = history.map(report => summarizeRun(report, definition))
    runs.push(...summaries)
    const latestRun = summaries[0] || null
    cards.push({
      definition,
      latestRun,
      runCount: summaries.length,
      successCount: summaries.filter(item => item.status === 'passed').length,
    })
  }
  runs.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')))
  cards.sort((a, b) => String(b.definition?.metadata?.updatedAt || '').localeCompare(String(a.definition?.metadata?.updatedAt || '')))
  return { workspace, inspections: cards, runs }
}

async function listDefinitions(storageRoot) {
  const root = join(storageRoot, 'inspections')
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const definitions = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !ID.test(entry.name)) continue
    try { definitions.push(await loadDefinition(storageRoot, entry.name)) } catch {}
  }
  return definitions
}

async function loadDefinition(storageRoot, id) {
  requireId(id, 'inspectionId')
  const raw = await readFile(join(storageRoot, 'inspections', id, 'inspection.json'), 'utf8')
  const parsed = JSON.parse(raw)
  if (!parsed || parsed.id !== id || !Array.isArray(parsed.steps)) throw new Error('stored inspection is invalid')
  return parsed
}

async function listRuns(storageRoot, inspectionId) {
  const root = join(storageRoot, 'runs', inspectionId)
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const reports = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !ID.test(entry.name)) continue
    try { reports.push(await loadRun(storageRoot, inspectionId, entry.name)) } catch {}
  }
  return reports.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')))
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

function summarizeRun(report, definition) {
  const results = Array.isArray(report.results) ? report.results : []
  const artifactCount = results.reduce((count, result) => count + (Array.isArray(result.artifacts) ? result.artifacts.length : 0), 0) + 2
  const passedSteps = results.filter(result => result.status === 'passed').length
  const failedSteps = results.filter(result => result.status === 'failed').length
  return {
    runId: report.runId,
    inspectionId: report.inspectionId,
    inspectionName: report.inspectionName || definition?.name || report.inspectionId,
    status: report.status || 'waiting',
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    summary: report.summary || summarizeResults(results),
    targetUrl: definition?.target?.url || '',
    expectedResult: report.expectedResult || definition?.expectedResult || '',
    stepCount: results.length,
    passedSteps,
    failedSteps,
    artifactCount,
  }
}

function summarizeResults(results) {
  const failed = results.find(result => result.status === 'failed')
  if (failed) return `${failed.name || failed.stepId || '步骤'}失败${failed.error ? `：${String(failed.error).slice(0, 120)}` : ''}`
  if (results.length === 0) return '尚未产生步骤结果'
  const passed = results.filter(result => result.status === 'passed').length
  return `完成 ${passed}/${results.length} 个步骤`
}

async function describeArtifacts(storageRoot, workspace, definition, report, prefix) {
  const rows = artifactCandidates(storageRoot, report)
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

function artifactCandidates(storageRoot, report) {
  const runRoot = join(storageRoot, 'runs', report.inspectionId, report.runId)
  const rows = [
    { token: 'report-json', kind: 'json-report', name: '巡检报告.json', path: join(runRoot, 'report.json') },
    { token: 'report-markdown', kind: 'markdown-report', name: '巡检报告.md', path: join(runRoot, 'report.md') },
  ]
  let index = 0
  for (const result of Array.isArray(report.results) ? report.results : []) {
    for (const artifact of Array.isArray(result.artifacts) ? result.artifacts : []) {
      if (!artifact || typeof artifact.path !== 'string') continue
      rows.push({
        token: `step-${index++}`,
        kind: artifact.kind || 'artifact',
        name: basename(artifact.path),
        path: artifact.path,
        stepId: result.stepId,
      })
    }
  }
  return rows
}

async function resolveArtifact(storageRoot, workspace, definition, report, token) {
  const row = artifactCandidates(storageRoot, report).find(item => item.token === token)
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
:root{color-scheme:light;--bg:#f6f8fb;--surface:#fff;--surface2:#f9fafb;--text:#172033;--muted:#667085;--line:#e6eaf0;--primary:#2563eb;--primary2:#eff6ff;--success:#0f9f6e;--success2:#ecfdf3;--danger:#d92d20;--danger2:#fef3f2;--warn:#b54708;--warn2:#fffaeb;--shadow:0 8px 30px rgba(15,23,42,.06);--radius:14px}
*{box-sizing:border-box}html,body{margin:0;height:100%;font-family:Inter,"PingFang SC","Microsoft YaHei",system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--text);background:var(--bg)}button,input,select{font:inherit}button{cursor:pointer}.app{min-height:100%;padding:24px 28px 40px}.page{max-width:1380px;margin:0 auto}.topbar{display:flex;gap:18px;align-items:flex-start;justify-content:space-between;margin-bottom:20px}.eyebrow{font-size:12px;color:var(--primary);font-weight:700;letter-spacing:.06em;margin-bottom:7px}.title{font-size:24px;font-weight:760;line-height:1.25;margin:0}.subtitle{margin-top:7px;color:var(--muted);font-size:13px;line-height:1.6}.actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.btn{height:36px;border:1px solid var(--line);background:var(--surface);color:var(--text);border-radius:10px;padding:0 13px;font-weight:600;font-size:13px;display:inline-flex;align-items:center;gap:7px;box-shadow:0 1px 2px rgba(15,23,42,.03)}.btn:hover{border-color:#cfd6e1;background:#fbfcfe}.btn.primary{background:var(--primary);border-color:var(--primary);color:#fff}.btn.ghost{background:transparent;box-shadow:none}.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow)}.panel{padding:20px}.muted{color:var(--muted)}.tiny{font-size:12px}.pill{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:4px 9px;font-size:12px;font-weight:650;background:#f2f4f7;color:#475467}.pill.ready,.pill.passed{background:var(--success2);color:var(--success)}.pill.failed{background:var(--danger2);color:var(--danger)}.pill.waiting,.pill.draft{background:var(--warn2);color:var(--warn)}.dot{width:7px;height:7px;border-radius:50%;background:currentColor}.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:14px 0 22px}.stat{padding:15px 16px;background:var(--surface);border:1px solid var(--line);border-radius:12px}.stat b{display:block;font-size:20px;margin-top:5px}.stat span{font-size:12px;color:var(--muted)}.flow-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:14px}.flow-card{padding:18px;transition:.18s ease;cursor:pointer;min-height:196px;display:flex;flex-direction:column}.flow-card:hover{transform:translateY(-2px);border-color:#c9d5ea;box-shadow:0 14px 34px rgba(37,99,235,.08)}.flow-icon{width:42px;height:42px;border-radius:12px;background:var(--primary2);color:var(--primary);display:grid;place-items:center;font-weight:800;margin-bottom:14px}.flow-name{font-size:16px;font-weight:720;margin-bottom:6px}.flow-desc{font-size:13px;color:var(--muted);line-height:1.55;min-height:40px}.flow-meta{margin-top:auto;padding-top:14px;border-top:1px solid var(--line);display:flex;justify-content:space-between;gap:10px;font-size:12px;color:var(--muted)}.url{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;font-size:12px;color:#475467}.hero{padding:22px 24px;margin-bottom:16px;background:linear-gradient(135deg,#fff 0%,#f7faff 100%)}.hero-row{display:flex;justify-content:space-between;gap:24px}.hero h2{font-size:22px;margin:0 0 8px}.hero p{margin:0;color:var(--muted);line-height:1.7;max-width:820px}.meta-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:18px}.meta-item{background:rgba(255,255,255,.8);border:1px solid var(--line);border-radius:11px;padding:12px 14px}.meta-item label{font-size:11px;color:var(--muted);display:block;margin-bottom:5px}.meta-item div{font-size:13px;font-weight:600;word-break:break-word}.section-title{font-size:15px;font-weight:720;margin:0 0 13px}.diagram{padding:20px}.step-list{position:relative;padding-left:11px}.step-row{position:relative;display:grid;grid-template-columns:34px minmax(0,1fr);gap:12px;padding-bottom:14px}.step-row:not(:last-child):before{content:"";position:absolute;left:16px;top:32px;bottom:-2px;width:2px;background:#e4e9f2}.step-index{width:34px;height:34px;border-radius:50%;display:grid;place-items:center;background:#fff;border:2px solid #cfd8e7;color:#475467;font-weight:700;font-size:12px;z-index:1}.step-row.tool .step-index{border-color:#9ec1ff;color:var(--primary);background:#f5f9ff}.step-row.checkpoint .step-index{border-color:#f5c77a;color:var(--warn);background:#fffaf0}.step-node{border:1px solid var(--line);background:#fff;border-radius:12px;padding:13px 15px}.step-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.step-name{font-size:13px;font-weight:700}.step-tool{font-size:11px;color:var(--muted);margin-top:4px}.step-note{font-size:12px;color:#475467;margin-top:9px;line-height:1.55}.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.chip{font-size:11px;padding:3px 7px;border-radius:7px;background:#f2f4f7;color:#475467}.toolbar{display:grid;grid-template-columns:minmax(220px,1fr) 160px 180px auto;gap:10px;margin-bottom:12px}.control{height:38px;border:1px solid var(--line);border-radius:10px;background:#fff;color:var(--text);padding:0 11px;outline:none}.control:focus{border-color:#8eb1ef;box-shadow:0 0 0 3px rgba(37,99,235,.08)}.table-wrap{overflow:auto}.table{width:100%;border-collapse:separate;border-spacing:0;font-size:13px}.table th{position:sticky;top:0;background:#f8fafc;color:#667085;font-size:11px;text-align:left;font-weight:700;padding:11px 14px;border-bottom:1px solid var(--line);white-space:nowrap}.table td{padding:13px 14px;border-bottom:1px solid #edf0f4;vertical-align:middle}.table tbody tr{cursor:pointer}.table tbody tr:hover{background:#fafcff}.table tbody tr:last-child td{border-bottom:0}.name-cell{font-weight:670}.summary-cell{color:#475467;max-width:430px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.empty{padding:64px 24px;text-align:center}.empty-icon{width:52px;height:52px;border-radius:16px;background:#f2f4f7;display:grid;place-items:center;margin:0 auto 14px;font-size:22px}.tabs{display:flex;gap:4px;border-bottom:1px solid var(--line);margin:0 0 16px}.tab{border:0;background:transparent;padding:10px 13px;color:var(--muted);font-size:13px;font-weight:650;border-bottom:2px solid transparent;margin-bottom:-1px}.tab.active{color:var(--primary);border-bottom-color:var(--primary)}.detail-grid{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(260px,.6fr);gap:14px}.summary-box{padding:18px;line-height:1.75;font-size:13px}.progress{height:8px;background:#eef1f5;border-radius:999px;overflow:hidden;margin-top:9px}.progress>i{display:block;height:100%;background:linear-gradient(90deg,#2563eb,#16a34a);border-radius:inherit}.timeline{padding:4px 0}.run-step{display:grid;grid-template-columns:20px 1fr;gap:12px;position:relative;padding-bottom:16px}.run-step:not(:last-child):before{content:"";position:absolute;left:8px;top:19px;bottom:-1px;width:1px;background:var(--line)}.run-dot{width:17px;height:17px;border-radius:50%;border:4px solid #d0d5dd;background:#fff;z-index:1;margin-top:2px}.run-step.passed .run-dot{border-color:#6ce0b0}.run-step.failed .run-dot{border-color:#fda29b}.run-step.waiting .run-dot{border-color:#fec84b}.run-body{border:1px solid var(--line);border-radius:11px;padding:12px 14px;background:#fff}.run-body-head{display:flex;justify-content:space-between;gap:12px}.run-output{font-size:12px;color:#475467;line-height:1.6;margin-top:8px;white-space:pre-wrap;max-height:105px;overflow:hidden}.artifact-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}.artifact{overflow:hidden}.artifact-preview{height:132px;background:#f2f4f7;display:grid;place-items:center;border-bottom:1px solid var(--line)}.artifact-preview img{width:100%;height:100%;object-fit:cover}.artifact-info{padding:12px}.artifact-name{font-size:13px;font-weight:680;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.artifact-meta{font-size:11px;color:var(--muted);margin-top:4px}.log{border:1px solid var(--line);border-radius:11px;background:#fff;margin-bottom:9px;overflow:hidden}.log summary{list-style:none;padding:12px 14px;cursor:pointer;font-size:13px;font-weight:650;display:flex;justify-content:space-between;gap:10px}.log summary::-webkit-details-marker{display:none}.code{margin:0;border-top:1px solid var(--line);background:#0f172a;color:#dbeafe;padding:14px;white-space:pre-wrap;word-break:break-word;font:12px/1.65 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;max-height:360px;overflow:auto}.modal-backdrop{position:fixed;inset:0;background:rgba(15,23,42,.48);display:grid;place-items:center;padding:30px;z-index:20}.modal{width:min(1000px,96vw);max-height:90vh;overflow:auto;background:#fff;border-radius:16px;box-shadow:0 30px 90px rgba(0,0,0,.3)}.modal-head{position:sticky;top:0;background:#fff;border-bottom:1px solid var(--line);padding:13px 16px;display:flex;justify-content:space-between;align-items:center;z-index:1}.modal-body{padding:16px}.modal-body img{display:block;max-width:100%;margin:auto;border-radius:10px}.loading{height:60vh;display:grid;place-items:center;color:var(--muted)}.spinner{width:24px;height:24px;border:3px solid #dbe4f2;border-top-color:var(--primary);border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 10px}@keyframes spin{to{transform:rotate(360deg)}}
@media(max-width:900px){.app{padding:18px}.stats{grid-template-columns:repeat(2,1fr)}.meta-grid{grid-template-columns:1fr}.toolbar{grid-template-columns:1fr 1fr}.toolbar input{grid-column:1/-1}.detail-grid{grid-template-columns:1fr}.topbar{flex-direction:column}.actions{width:100%}}
</style>
</head>
<body><main class="app"><div id="root" class="page"><div class="loading"><div><div class="spinner"></div>正在读取巡检数据…</div></div></div></main>
<script>
const API=${api};
const qs=new URLSearchParams(location.search);const MODE=qs.get('mode')==='records'?'records':'flows';const WORKSPACE=qs.get('workspace')||'';const CURRENT=qs.get('current')||'';
const root=document.getElementById('root');let catalog=null;let selectedFlow=CURRENT;let selectedRun=null;let runDetail=null;let detailTab='overview';let preview=null;
const esc=v=>String(v??'').replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]));
const fmt=t=>{if(!t)return'—';const d=new Date(t);return Number.isNaN(d.getTime())?esc(t):d.toLocaleString('zh-CN',{hour12:false})};
const dur=(a,b)=>{const x=new Date(a).getTime(),y=new Date(b).getTime();if(!Number.isFinite(x)||!Number.isFinite(y)||y<x)return'—';const ms=y-x;if(ms<1000)return ms+' ms';if(ms<60000)return(ms/1000).toFixed(1)+' 秒';return Math.floor(ms/60000)+' 分 '+Math.round(ms%60000/1000)+' 秒'};
const pill=s=>'<span class="pill '+esc(s)+'"><i class="dot"></i>'+({passed:'通过',failed:'失败',waiting:'等待中',ready:'已就绪',draft:'草稿'}[s]||esc(s||'未知'))+'</span>';
const host=u=>{try{return new URL(u).host}catch{return u||'—'}};
const stepArtifacts=r=>(r.results||[]).reduce((n,x)=>n+((x.artifacts||[]).length),0)+2;
async function get(path){const r=await fetch(API+path,{cache:'no-store',credentials:'same-origin'});const p=await r.json();if(!r.ok||p.ok!==true)throw new Error(p.error||'请求失败');return p}
async function boot(){try{catalog=await get('/catalog?workspace='+encodeURIComponent(WORKSPACE));render()}catch(e){root.innerHTML=empty('无法读取巡检数据',e.message)}}
function empty(title,sub){return '<div class="card empty"><div class="empty-icon">◎</div><div style="font-weight:720">'+esc(title)+'</div><div class="muted tiny" style="margin-top:7px">'+esc(sub||'')+'</div></div>'}
function header(title,sub,actions=''){return '<div class="topbar"><div><div class="eyebrow">DSH PATROL</div><h1 class="title">'+esc(title)+'</h1><div class="subtitle">'+esc(sub)+'</div></div><div class="actions">'+actions+'</div></div>'}
function render(){if(!WORKSPACE){root.innerHTML=header(MODE==='flows'?'流程管理':'巡检记录','当前会话没有可识别的工作区路径。')+empty('暂无工作区','请从一个已打开工作区的巡检会话进入。');return}MODE==='flows'?renderFlows():renderRecords()}
function renderFlows(){const cards=catalog.inspections||[];const current=cards.find(x=>x.definition.id===selectedFlow);if(current){renderFlowDetail(current);return}const success=(catalog.runs||[]).filter(x=>x.status==='passed').length;root.innerHTML=header('流程管理','集中管理当前工作区的巡检流程。卡片展示业务信息，点击后查看流程图、步骤与历史运行。','<button class="btn" onclick="refresh()">↻ 刷新</button>')+'<div class="stats"><div class="stat"><span>流程总数</span><b>'+cards.length+'</b></div><div class="stat"><span>已就绪</span><b>'+cards.filter(x=>x.definition.status==='ready').length+'</b></div><div class="stat"><span>历史巡检</span><b>'+(catalog.runs||[]).length+'</b></div><div class="stat"><span>成功记录</span><b>'+success+'</b></div></div>'+(cards.length?'<div class="flow-grid">'+cards.map(flowCard).join('')+'</div>':empty('还没有流程','在当前工作区教学并保存第一个巡检流程后，这里会自动出现。'))}
function flowCard(x){const d=x.definition,l=x.latestRun;return '<article class="card flow-card" onclick="openFlow(\''+esc(d.id)+'\')"><div class="flow-icon">'+String((d.name||d.id).trim().charAt(0)||'流').toUpperCase()+'</div><div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start"><div class="flow-name">'+esc(d.name||d.id)+'</div>'+pill(d.status)+'</div><div class="flow-desc">'+esc(d.description||'暂无流程说明')+'</div><div class="url" title="'+esc(d.target?.url||'')+'">'+esc(host(d.target?.url||''))+'</div><div class="flow-meta"><span>'+((d.steps||[]).length)+' 个步骤 · '+x.runCount+' 次运行</span><span>'+(l?fmt(l.startedAt):'尚未运行')+'</span></div></article>'}
function openFlow(id){selectedFlow=id;renderFlows();window.scrollTo(0,0)}function closeFlow(){selectedFlow='';renderFlows();window.scrollTo(0,0)}
function renderFlowDetail(x){const d=x.definition,l=x.latestRun;const actions='<button class="btn" onclick="closeFlow()">← 返回全部流程</button><button class="btn" onclick="refresh()">↻ 刷新</button>';root.innerHTML=header('流程详情','默认展示当前会话正在使用的流程，也可以返回查看当前工作区的全部流程。',actions)+'<section class="card hero"><div class="hero-row"><div><div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">'+pill(d.status)+'<span class="tiny muted">'+esc(d.id)+'</span></div><h2>'+esc(d.name||d.id)+'</h2><p>'+esc(d.description||'暂无流程说明')+'</p></div></div><div class="meta-grid"><div class="meta-item"><label>目标地址</label><div>'+esc(d.target?.url||'—')+'</div></div><div class="meta-item"><label>预期结果</label><div>'+esc(d.expectedResult||'—')+'</div></div><div class="meta-item"><label>最近更新</label><div>'+fmt(d.metadata?.updatedAt)+'</div></div><div class="meta-item"><label>步骤数量</label><div>'+((d.steps||[]).length)+' 个</div></div><div class="meta-item"><label>认证方式</label><div>'+esc(d.auth?.mode||'none')+'</div></div><div class="meta-item"><label>最近运行</label><div>'+(l?(pill(l.status)+' '+fmt(l.startedAt)):'尚未运行')+'</div></div></div></section><div class="detail-grid"><section class="card diagram"><h3 class="section-title">流程图</h3><div class="muted tiny" style="margin-bottom:16px">将文字 Runbook 转换为清晰的执行路径；点击节点可展开业务说明与规则。</div>'+flowDiagram(d.steps||[])+'</section><section class="card panel"><h3 class="section-title">流程信息</h3>'+infoRow('产物类型',(d.artifacts||[]).join('、')||'未指定')+infoRow('计划任务',d.schedule?.enabled?(d.schedule.cron||'已启用'):'未启用')+infoRow('工作区',d.metadata?.workspaceRoot||'—')+infoRow('创建时间',fmt(d.metadata?.createdAt))+infoRow('验证时间',fmt(d.metadata?.validatedAt))+'</section></div>'+recentRuns(x)}
function infoRow(a,b){return '<div style="padding:11px 0;border-bottom:1px solid var(--line)"><div class="tiny muted">'+esc(a)+'</div><div style="font-size:13px;font-weight:620;margin-top:4px;word-break:break-word">'+esc(b)+'</div></div>'}
function flowDiagram(steps){if(!steps.length)return empty('暂无步骤','该流程还没有记录可复用步骤。');return '<div class="step-list">'+steps.map((s,i)=>'<div class="step-row '+esc(s.kind)+'"><div class="step-index">'+(i+1)+'</div><details class="step-node"><summary style="list-style:none;cursor:pointer"><div class="step-head"><div><div class="step-name">'+esc(s.name||s.id)+'</div><div class="step-tool">'+(s.kind==='checkpoint'?'人工确认节点':esc(s.tool||'工具步骤'))+'</div></div><span class="chip">'+esc(s.kind==='checkpoint'?'检查点':'自动执行')+'</span></div></summary>'+(s.notes?'<div class="step-note">'+esc(s.notes)+'</div>':'')+'<div class="chips">'+(s.expectation?'<span class="chip">校验 '+esc(s.expectation.mode)+'</span>':'')+(s.when?'<span class="chip">条件分支</span>':'')+(s.artifact?'<span class="chip">产物 '+esc(s.artifact)+'</span>':'')+(s.locator?'<span class="chip">语义定位</span>':'')+'</div></details></div>').join('')+'</div>'}
function recentRuns(x){const rows=(catalog.runs||[]).filter(r=>r.inspectionId===x.definition.id).slice(0,5);return '<section class="card panel" style="margin-top:14px"><div style="display:flex;justify-content:space-between;align-items:center"><h3 class="section-title">最近巡检</h3><span class="tiny muted">共 '+x.runCount+' 次</span></div>'+(rows.length?'<div class="table-wrap"><table class="table"><thead><tr><th>时间</th><th>状态</th><th>概述</th><th>步骤</th><th>耗时</th></tr></thead><tbody>'+rows.map(r=>'<tr onclick="openRun(\''+esc(r.inspectionId)+'\',\''+esc(r.runId)+'\')"><td>'+fmt(r.startedAt)+'</td><td>'+pill(r.status)+'</td><td class="summary-cell">'+esc(r.summary||'—')+'</td><td>'+r.passedSteps+'/'+r.stepCount+'</td><td>'+dur(r.startedAt,r.finishedAt)+'</td></tr>').join('')+'</tbody></table></div>':'<div class="muted tiny">还没有历史运行。</div>')+'</section>'}
function renderRecords(){if(selectedRun&&runDetail){renderRunDetail();return}const runs=catalog.runs||[];root.innerHTML=header('巡检记录','一条记录代表一次完整巡检。支持搜索、状态筛选和排序，点击记录查看概述、步骤、日志与产物。','<button class="btn" onclick="refresh()">↻ 刷新</button>')+'<div class="stats"><div class="stat"><span>巡检总数</span><b>'+runs.length+'</b></div><div class="stat"><span>通过</span><b>'+runs.filter(x=>x.status==='passed').length+'</b></div><div class="stat"><span>失败</span><b>'+runs.filter(x=>x.status==='failed').length+'</b></div><div class="stat"><span>等待处理</span><b>'+runs.filter(x=>x.status==='waiting').length+'</b></div></div><div class="toolbar"><input id="search" class="control" placeholder="搜索流程、概述、目标地址…" oninput="filterRecords()"><select id="status" class="control" onchange="filterRecords()"><option value="all">全部状态</option><option value="passed">通过</option><option value="failed">失败</option><option value="waiting">等待中</option></select><select id="sort" class="control" onchange="filterRecords()"><option value="new">时间：最新优先</option><option value="old">时间：最早优先</option><option value="name">流程名称</option></select><div class="tiny muted" style="align-self:center;text-align:right"><span id="count">'+runs.length+'</span> 条记录</div></div><section class="card table-wrap"><table class="table"><thead><tr><th>巡检时间</th><th>流程</th><th>状态</th><th>概述</th><th>目标</th><th>步骤</th><th>产物</th><th>耗时</th></tr></thead><tbody id="records-body"></tbody></table><div id="records-empty" style="display:none"></div></section>';filterRecords()}
function filterRecords(){const q=(document.getElementById('search')?.value||'').trim().toLowerCase(),s=document.getElementById('status')?.value||'all',sort=document.getElementById('sort')?.value||'new';let rows=(catalog.runs||[]).filter(r=>(s==='all'||r.status===s)&&(!q||[r.inspectionName,r.summary,r.targetUrl,r.inspectionId].join(' ').toLowerCase().includes(q)));rows=rows.slice().sort((a,b)=>sort==='old'?String(a.startedAt).localeCompare(String(b.startedAt)):sort==='name'?String(a.inspectionName).localeCompare(String(b.inspectionName),'zh-CN'):String(b.startedAt).localeCompare(String(a.startedAt)));const body=document.getElementById('records-body');if(!body)return;body.innerHTML=rows.map(recordRow).join('');document.getElementById('count').textContent=rows.length;const e=document.getElementById('records-empty');e.style.display=rows.length?'none':'block';e.innerHTML=rows.length?'':empty('没有匹配的巡检记录','调整关键词或状态筛选条件后再试。')}
function recordRow(r){return '<tr onclick="openRun(\''+esc(r.inspectionId)+'\',\''+esc(r.runId)+'\')"><td style="white-space:nowrap">'+fmt(r.startedAt)+'</td><td><div class="name-cell">'+esc(r.inspectionName)+'</div><div class="tiny muted">'+esc(r.inspectionId)+'</div></td><td>'+pill(r.status)+'</td><td class="summary-cell" title="'+esc(r.summary||'')+'">'+esc(r.summary||'—')+'</td><td><div class="url" style="max-width:180px" title="'+esc(r.targetUrl||'')+'">'+esc(host(r.targetUrl))+'</div></td><td>'+r.passedSteps+'/'+r.stepCount+'</td><td>'+r.artifactCount+'</td><td style="white-space:nowrap">'+dur(r.startedAt,r.finishedAt)+'</td></tr>'}
async function openRun(inspectionId,runId){selectedRun={inspectionId,runId};root.innerHTML='<div class="loading"><div><div class="spinner"></div>正在读取巡检详情…</div></div>';try{runDetail=await get('/run?workspace='+encodeURIComponent(WORKSPACE)+'&inspectionId='+encodeURIComponent(inspectionId)+'&runId='+encodeURIComponent(runId));detailTab='overview';renderRunDetail()}catch(e){selectedRun=null;runDetail=null;root.innerHTML=empty('无法读取巡检详情',e.message)}}
function closeRun(){selectedRun=null;runDetail=null;detailTab='overview';MODE==='flows'?renderFlows():renderRecords();window.scrollTo(0,0)}function setTab(t){detailTab=t;renderRunDetail()}
function renderRunDetail(){const r=runDetail.report,d=runDetail.definition,a=runDetail.artifacts||[];const actions='<button class="btn" onclick="closeRun()">← 返回'+(MODE==='flows'?'流程':'巡检记录')+'</button>';root.innerHTML=header('巡检详情',esc(r.inspectionName||d.name||r.inspectionId),actions)+'<section class="card hero"><div style="display:flex;justify-content:space-between;gap:16px;align-items:flex-start"><div><div style="margin-bottom:8px">'+pill(r.status)+'</div><h2>'+esc(r.inspectionName||d.name)+'</h2><p>'+esc(r.summary||'本次巡检已完成，详细信息见下方步骤与产物。')+'</p></div><div class="tiny muted" style="text-align:right">'+fmt(r.startedAt)+'<br>'+dur(r.startedAt,r.finishedAt)+'</div></div></section><div class="tabs">'+[['overview','概述'],['steps','步骤'],['artifacts','产物'],['logs','日志']].map(x=>'<button class="tab '+(detailTab===x[0]?'active':'')+'" onclick="setTab(\''+x[0]+'\')">'+x[1]+'</button>').join('')+'</div><div id="detail-content">'+detailContent(r,d,a)+'</div>'}
function detailContent(r,d,a){if(detailTab==='steps')return stepsView(r);if(detailTab==='artifacts')return artifactsView(a);if(detailTab==='logs')return logsView(r,d);const results=r.results||[],passed=results.filter(x=>x.status==='passed').length,rate=results.length?Math.round(passed/results.length*100):0;return '<div class="detail-grid"><section class="card summary-box"><h3 class="section-title">本次巡检概述</h3><div>'+esc(r.summary||'没有额外摘要。')+'</div><div class="progress"><i style="width:'+rate+'%"></i></div><div class="tiny muted" style="margin-top:7px">步骤完成 '+passed+'/'+results.length+' · '+rate+'%</div></section><section class="card panel"><h3 class="section-title">关键信息</h3>'+infoRow('目标地址',d.target?.url||'—')+infoRow('预期结果',r.expectedResult||d.expectedResult||'—')+infoRow('开始时间',fmt(r.startedAt))+infoRow('结束时间',fmt(r.finishedAt))+infoRow('产物数量',String(a.length))+'</section></div>'}
function stepsView(r){const rows=r.results||[];if(!rows.length)return empty('暂无步骤结果','本次巡检没有可展示的步骤记录。');return '<section class="card panel"><div class="timeline">'+rows.map(x=>'<div class="run-step '+esc(x.status)+'"><div class="run-dot"></div><div class="run-body"><div class="run-body-head"><div><div class="name-cell">'+esc(x.name||x.stepId)+'</div><div class="tiny muted">'+esc(x.tool||x.kind||'步骤')+'</div></div>'+pill(x.status)+'</div><div class="tiny muted" style="margin-top:7px">'+fmt(x.startedAt)+' · '+dur(x.startedAt,x.finishedAt)+'</div>'+(x.error?'<div class="run-output" style="color:var(--danger)">'+esc(x.error)+'</div>':x.output?'<div class="run-output">'+esc(x.output)+'</div>':'')+'</div></div>').join('')+'</div></section>'}
function artifactsView(a){if(!a.length)return empty('暂无产物','本次巡检没有保存可预览的产物。');return '<div class="artifact-grid">'+a.map(x=>'<article class="card artifact"><div class="artifact-preview">'+(x.preview==='image'?'<img loading="lazy" src="'+esc(x.url)+'" alt="'+esc(x.name)+'">':'<div style="font-size:28px">'+(x.preview==='text'?'▤':'⇩')+'</div>')+'</div><div class="artifact-info"><div class="artifact-name" title="'+esc(x.name)+'">'+esc(x.name)+'</div><div class="artifact-meta">'+esc(x.kind)+' · '+formatBytes(x.size)+'</div><div style="margin-top:10px"><button class="btn" onclick="previewArtifact(event,\''+esc(x.token)+'\')">'+(x.preview==='download'?'打开':'预览')+'</button></div></div></article>').join('')+'</div>'}
function logsView(r,d){const byId=new Map((d.steps||[]).map(x=>[x.id,x]));return '<div>'+((r.results||[]).map(x=>{const def=byId.get(x.stepId)||{};return '<details class="log"><summary><span>'+esc(x.name||x.stepId)+'</span>'+pill(x.status)+'</summary><pre class="code">工具: '+esc(x.tool||def.tool||x.kind||'')+'\n\n参数:\n'+esc(JSON.stringify(def.arguments||{},null,2))+'\n\n输出:\n'+esc(x.output||'')+(x.error?'\n\n错误:\n'+esc(x.error):'')+'</pre></details>'}).join('')||empty('暂无日志','本次巡检没有步骤日志。'))+'</div>'}
function formatBytes(n){if(!Number.isFinite(n))return'—';if(n<1024)return n+' B';if(n<1024*1024)return(n/1024).toFixed(1)+' KB';return(n/1024/1024).toFixed(1)+' MB'}
async function previewArtifact(ev,token){ev.stopPropagation();const a=(runDetail.artifacts||[]).find(x=>x.token===token);if(!a)return;if(a.preview==='download'){window.open(a.url,'_blank','noopener');return}preview=a;document.body.insertAdjacentHTML('beforeend','<div id="preview" class="modal-backdrop" onclick="if(event.target===this)closePreview()"><div class="modal"><div class="modal-head"><b>'+esc(a.name)+'</b><button class="btn" onclick="closePreview()">关闭</button></div><div id="preview-body" class="modal-body"><div class="loading" style="height:220px"><div><div class="spinner"></div>正在加载预览…</div></div></div></div></div>');const body=document.getElementById('preview-body');if(a.preview==='image'){body.innerHTML='<img src="'+esc(a.url)+'" alt="'+esc(a.name)+'">';return}try{const r=await fetch(a.url,{cache:'no-store'});let text=await r.text();if(a.mime?.startsWith('application/json')){try{text=JSON.stringify(JSON.parse(text),null,2)}catch{}}body.innerHTML='<pre class="code" style="border-radius:10px;max-height:70vh">'+esc(text)+'</pre>'}catch(e){body.innerHTML=empty('预览失败',e.message)}}function closePreview(){document.getElementById('preview')?.remove();preview=null}
async function refresh(){selectedRun=null;runDetail=null;root.innerHTML='<div class="loading"><div><div class="spinner"></div>正在刷新…</div></div>';try{catalog=await get('/catalog?workspace='+encodeURIComponent(WORKSPACE));render()}catch(e){root.innerHTML=empty('刷新失败',e.message)}}
boot();
</script></body></html>`
}
