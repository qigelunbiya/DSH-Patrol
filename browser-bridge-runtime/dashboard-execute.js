import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const ID = /^[A-Za-z0-9._-]+$/
const MAX_BODY_BYTES = 32 * 1024
const PATROL_PRESET_ID = 'patrol'

/**
 * Flow-management execution path:
 *   deterministic patrol_run_flow -> only on failure -> tiny patrol_recover worker.
 *
 * The ordinary model is never called to decide that a READY flow should be
 * replayed. An ephemeral Patrol agent exists only to provide the scoped tool
 * runtime/composite dispatch boundary; no prompt is sent to it.
 */
export function registerPatrolDashboardExecuteRoute(ctx, basePath, config = {}) {
  const prefix = `${String(basePath || '/patrol-browser-bridge').replace(/\/$/, '')}/dashboard`
  const storageRoot = resolveDashboardStorage(config)
  return ctx.webServer.register({
    kind: 'exact',
    path: `${prefix}/execute`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST'])
      try {
        const body = await readJsonBody(req)
        const inspectionId = requireId(body.inspectionId, 'inspectionId')
        const workspace = requireText(body.workspace, 'workspace', 4096)
        const parentSessionId = requireText(body.parentSessionId, 'parentSessionId', 256)
        const definition = await loadDefinition(storageRoot, inspectionId)
        assertWorkspace(definition, workspace)
        const result = await executeDeterministicWithRecovery(
          ctx,
          storageRoot,
          workspace,
          parentSessionId,
          inspectionId,
        )
        return sendJson(res, 200, { ok: true, ...result })
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: safeError(error) })
      }
    },
  })
}

export async function executeDeterministicWithRecovery(
  ctx,
  storageRoot,
  workspace,
  parentSessionId,
  inspectionId,
) {
  const rootAgents = optionalService(ctx, 'agents')
  if (!rootAgents || typeof rootAgents.get !== 'function') throw new Error('Harness agent registry is unavailable')
  const parent = rootAgents.get(parentSessionId)
  if (!parent) throw new Error('the originating Patrol session is no longer active')
  const parentCwd = parent.session?.header?.cwd
  if (!samePath(parentCwd, workspace)) throw new Error('originating session workspace does not match this Patrol flow')

  const ownerAgents = optionalService(parent.ctx, 'agents') || rootAgents
  if (typeof ownerAgents.create !== 'function') throw new Error('Harness agent factory is unavailable')
  const helperId = `patrol-dashboard-${randomUUID()}`
  const parentDepth = Number.isInteger(parent.session?.header?.delegationDepth)
    ? parent.session.header.delegationDepth
    : 0
  const handle = await ownerAgents.create({
    sessionId: helperId,
    meta: {
      cwd: workspace,
      parentSession: parentSessionId,
      origin: 'subagent',
      delegationDepth: parentDepth + 1,
      agentPreset: PATROL_PRESET_ID,
    },
    ...(parent.options === undefined ? {} : { agentOptions: parent.options }),
  })

  try {
    const tools = optionalService(handle.agent.ctx, 'tools')
    if (!tools || typeof tools.execute !== 'function') throw new Error('Patrol helper ToolRuntime is unavailable')
    const first = await executeTool(tools, handle.agent, 'patrol_run_flow', { flow: inspectionId })
    if (first.isError) throw new Error(`deterministic Patrol replay could not start: ${first.error}`)

    const runId = matchLine(first.text, /^runId=(.+)$/m)
    const initialStatus = matchLine(first.text, /^runStatus=(passed|failed|waiting)$/m)
    if (!runId || !initialStatus) throw new Error('patrol_run_flow returned no machine-readable run status')
    let report = await loadRun(storageRoot, inspectionId, runId)

    if (initialStatus !== 'failed') {
      return {
        inspectionId,
        runId,
        status: report.status,
        recoveryAttempted: false,
        recovered: false,
        message: initialStatus === 'passed'
          ? '确定性 Runner 已完成巡检；本次执行没有调用模型。'
          : '确定性 Runner 已暂停在人工 checkpoint；本次执行尚未调用恢复模型。',
      }
    }

    const failure = report.results.find(result => result.status === 'failed')
    const recoveryPrompt = [
      `Recover the blocked deterministic Patrol run for inspectionId=${inspectionId}.`,
      `runId=${runId}`,
      `failedStep=${failure?.stepId || '(unknown)'}`,
      `failedTool=${failure?.tool || failure?.kind || '(unknown)'}`,
      `error=${safeSingleLine(failure?.error || 'unknown deterministic failure')}`,
      '',
      'Use patrol_last_failure for this exact run, then patrol_observe the CURRENT page.',
      'Perform at most 3 patrol_recovery_action calls to remove only the transient blocker.',
      'Do not edit/reteach the Runbook. When unblocked call patrol_resume_flow exactly once.',
      'If that resume still fails, stop and report the new failure instead of looping.',
    ].join('\n')

    const recovery = await executeTool(tools, handle.agent, 'patrol_recover', {
      description: `Recover Patrol ${inspectionId} at ${failure?.stepId || 'failed step'}`,
      prompt: recoveryPrompt,
    })
    report = await loadRun(storageRoot, inspectionId, runId)
    const recovered = !recovery.isError && report.status === 'passed'
    return {
      inspectionId,
      runId,
      status: report.status,
      recoveryAttempted: true,
      recovered,
      ...(recovery.isError ? { recoveryError: recovery.error } : {}),
      recoveryOutput: recovery.text.slice(0, 4000),
      message: recovered
        ? '确定性 Runner 遇到异常后由轻量 Recovery Agent 临时解阻，并已回到同一 Runner 完成巡检。'
        : '确定性 Runner 遇到异常；Recovery Agent 已做一次有界恢复尝试，但流程仍未通过。Runbook 未被自动修改。',
    }
  } finally {
    await handle.dispose()
  }
}

async function executeTool(tools, agent, name, argumentsValue) {
  const callId = `patrol-dashboard-${randomUUID()}`
  const result = await tools.execute({
    callId,
    rootCallId: callId,
    name,
    arguments: argumentsValue,
    signal: new AbortController().signal,
    agent,
  })
  const text = Array.isArray(result?.content)
    ? result.content.map(block => block?.type === 'text' ? String(block.text || '') : `[${block?.type || 'content'}]`).join('\n')
    : ''
  return {
    isError: result?.isError === true,
    text,
    error: result?.isError === true ? safeError(result.error) : '',
  }
}

async function loadDefinition(storageRoot, inspectionId) {
  const raw = await readFile(join(storageRoot, 'inspections', inspectionId, 'inspection.json'), 'utf8')
  const parsed = JSON.parse(raw)
  if (!parsed || parsed.id !== inspectionId || !Array.isArray(parsed.steps)) throw new Error('stored inspection is invalid')
  return parsed
}

async function loadRun(storageRoot, inspectionId, runId) {
  const raw = await readFile(join(storageRoot, 'runs', inspectionId, runId, 'report.json'), 'utf8')
  const parsed = JSON.parse(raw)
  if (!parsed || parsed.inspectionId !== inspectionId || parsed.runId !== runId || !Array.isArray(parsed.results)) {
    throw new Error('stored run report is invalid')
  }
  return parsed
}

function resolveDashboardStorage(config) {
  if (typeof config.storagePath === 'string' && config.storagePath.trim()) return resolve(config.storagePath)
  if (typeof config.screenshotDir === 'string' && config.screenshotDir.trim()) return resolve(dirname(config.screenshotDir))
  return resolve(process.cwd(), '.dsh-patrol')
}

function optionalService(ctx, name) {
  try { return ctx?.get?.(name) } catch { return undefined }
}

function assertWorkspace(definition, workspace) {
  const owner = definition?.metadata?.workspaceRoot
  if (!owner || !samePath(owner, workspace)) throw new Error('inspection does not belong to the current workspace')
}

function samePath(a, b) {
  const left = normalizedPath(a)
  const right = normalizedPath(b)
  return left !== '' && left === right
}

function normalizedPath(value) {
  if (typeof value !== 'string' || !value.trim()) return ''
  const full = resolve(value)
  return process.platform === 'win32' ? full.toLowerCase() : full
}

function requireId(value, name) {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error(`invalid ${name}`)
  return value
}

function requireText(value, name, maxLength) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) throw new Error(`invalid ${name}`)
  return value.trim()
}

async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new Error('request body is too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) throw new Error('request body is required')
  let parsed
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('request body is not valid JSON') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('request body must be an object')
  return parsed
}

function matchLine(text, pattern) {
  const match = pattern.exec(String(text || ''))
  return match ? String(match[1] || '').trim() : ''
}

function safeSingleLine(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').slice(0, 1200)
}

function safeError(error) {
  return error instanceof Error ? error.message : String(error?.message || error || 'unknown error')
}

function methodNotAllowed(res, allow) {
  res.writeHead(405, { allow: allow.join(', '), 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(value))
}
