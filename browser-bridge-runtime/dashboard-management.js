import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { internalPatrolWorkerPath, mountInternalPatrolWorker } from './internal-worker.js'
import { compactFlowConservatively } from './safe-flow-cleanup.js'

const ID = /^[A-Za-z0-9._-]+$/
const MAX_BODY_BYTES = 32 * 1024
const WORKSPACE_OUTPUT_ROOT = 'patrol-results'
const NAMED_RUNBOOK_SUFFIX = '.flow.md'

export function registerPatrolDashboardManagementRoutes(ctx, basePath, config = {}) {
  const prefix = `${String(basePath || '/patrol-browser-bridge').replace(/\/$/, '')}/dashboard`
  const storageRoot = resolveDashboardStorage(config)
  const disposers = []

  // Dashboard replay bypasses the conversation model completely. The Host
  // creates a persona-free replay Agent, invokes patrol_run_flow (or checkpoint
  // resume) inside runMaintenance, and disposes that Agent when the deterministic
  // runner settles. Only a real unexpected browser-step failure launches a
  // narrow Recovery model worker.
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${prefix}/flow/run`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST'])
      try {
        const body = await readJsonBody(req)
        const inspectionId = requireId(body.inspectionId, 'inspectionId')
        const workspace = requireWorkspace(body.workspace)
        const definition = await loadDefinition(storageRoot, inspectionId)
        assertWorkspace(definition, workspace)
        if (definition.steps.length === 0) throw new Error(`inspection ${inspectionId} has no reusable steps`)

        const pending = await loadResumeState(storageRoot, inspectionId)
        if (pending?.reason === 'recovery') {
          return sendJson(res, 409, {
            ok: false,
            error: `inspection ${inspectionId} is already paused for recovery in run ${pending.runId}`,
          })
        }
        const replayTool = pending === undefined ? 'patrol_run_flow' : 'patrol_resume_flow'
        const replayText = await executeReplayWorker(ctx, config.workerRoot, workspace, inspectionId, replayTool)
        const runId = extractField(replayText, 'runId')
        if (!runId) throw new Error(`deterministic replay for ${inspectionId} returned no runId`)
        const report = await loadRunReport(storageRoot, inspectionId, runId)
        const reportPath = extractField(replayText, 'report') || join(storageRoot, 'runs', inspectionId, runId, 'report.md')

        let recoverySessionId
        const failure = lastRecoverableFailure(report)
        if (report.status === 'failed' && failure !== undefined) {
          recoverySessionId = await launchRecoveryWorker(ctx, config.workerRoot, workspace, definition, report, failure)
        }

        return sendJson(res, 200, {
          ok: true,
          zeroModelReplay: true,
          inspectionId,
          runId,
          status: report.status,
          report: reportPath,
          ...(recoverySessionId === undefined ? {} : { recoverySessionId }),
        })
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: safeError(error) })
      }
    },
  }))

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
        const result = compactFlowConservatively(definition)
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
          // directory so test flows do not survive in records or on disk.
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

async function executeReplayWorker(ctx, workerRoot, workspace, inspectionId, replayTool) {
  const agents = ctx.get('agents')
  if (!agents) throw new Error('Harness Agent registry is unavailable for direct Dashboard replay')
  const compositionPath = internalPatrolWorkerPath(String(workerRoot || ''), 'replay')
  const handle = await agents.create({
    sessionId: `patrol-dashboard-replay-${randomUUID()}`,
    meta: { cwd: workspace },
    setup: async agentCtx => { await mountInternalPatrolWorker(ctx, agentCtx, compositionPath, 'replay') },
  })
  try {
    return await handle.agent.runMaintenance(async signal => {
      const result = await handle.agent.ctx.tools.execute({
        callId: CallId(`patrol-dashboard-${randomUUID()}`),
        name: replayTool,
        arguments: { flow: inspectionId },
        signal,
        agent: handle.agent,
      })
      if (result.isError) throw new Error(result.error.message)
      if (typeof result.value === 'string') return result.value
      return result.content.map(block => block.type === 'text' ? block.text : `[${block.type}]`).join('\n')
    })
  } finally {
    await handle.dispose()
  }
}

async function launchRecoveryWorker(ctx, workerRoot, workspace, definition, report, failure) {
  const agents = ctx.get('agents')
  if (!agents) throw new Error('Harness Agent registry is unavailable for Recovery')
  const compositionPath = internalPatrolWorkerPath(String(workerRoot || ''), 'recovery')
  const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
  const agentOptions = selection?.provider && selection?.model
    ? { provider: selection.provider, model: selection.model, ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }) }
    : undefined
  const handle = await agents.create({
    sessionId: `session-${randomUUID()}`,
    meta: { cwd: workspace },
    ...(agentOptions === undefined ? {} : { agentOptions }),
    setup: async agentCtx => { await mountInternalPatrolWorker(ctx, agentCtx, compositionPath, 'recovery') },
  })
  try {
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: recoveryPrompt(definition, report, failure) }],
      source: { kind: 'user' },
    }))
  } catch (error) {
    await handle.dispose().catch(() => {})
    throw error
  }
  return String(handle.agent.id)
}

function recoveryPrompt(definition, report, failure) {
  const failedIndex = report.results.findIndex(item => item.stepId === failure.stepId && item.status === 'failed')
  const nearby = report.results.slice(Math.max(0, failedIndex - 2), failedIndex + 1)
  const context = nearby.map(item => [
    `${item.stepId} ${item.name} [${item.status}]${item.tool ? ` tool=${item.tool}` : ''}`,
    item.error ? `error=${trimContext(item.error, 700)}` : '',
    item.output ? `output=${trimContext(item.output, 900)}` : '',
  ].filter(Boolean).join('\n')).join('\n---\n')
  return [
    '你是 DSH Patrol 的按需 Recovery Worker。正常流程已经由 deterministic runner 执行；只有当前异常需要模型介入。',
    '只解除当前浏览器阻塞，不从头重跑，不创建、不重教、不修改 Runbook，也不要处理明文秘密。',
    '确认阻塞解除后调用一次 patrol_resume_after_recovery，把控制权交还 deterministic runner。无法安全恢复就停止并说明原因。',
    '',
    `flow=${definition.id} (${definition.name || definition.id})`,
    `runId=${report.runId}`,
    `failedStep=${failure.stepId}`,
    '',
    context || '(no nearby step context)',
  ].join('\n')
}

function lastRecoverableFailure(report) {
  return [...report.results].reverse().find(item => item.status === 'failed'
    && item.stepId !== 'artifact-check'
    && typeof item.tool === 'string'
    && item.tool.startsWith('browser_'))
}

async function loadRunReport(storageRoot, inspectionId, runId) {
  if (!ID.test(runId)) throw new Error('invalid runId returned by replay worker')
  const raw = await readFile(join(storageRoot, 'runs', inspectionId, runId, 'report.json'), 'utf8')
  const report = JSON.parse(raw)
  if (!report || report.inspectionId !== inspectionId || report.runId !== runId || !Array.isArray(report.results)) {
    throw new Error('stored run report is invalid')
  }
  return report
}

async function loadResumeState(storageRoot, inspectionId) {
  try {
    const raw = await readFile(join(storageRoot, 'resumes', `${inspectionId}.json`), 'utf8')
    const state = JSON.parse(raw)
    if (!state || state.inspectionId !== inspectionId || typeof state.runId !== 'string') throw new Error('stored resume state is invalid')
    return state
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

function extractField(text, field) {
  const line = String(text || '').split(/\r?\n/u).find(item => item.startsWith(`${field}=`))
  const value = line?.slice(field.length + 1).trim()
  return value || undefined
}

function trimContext(value, max) {
  const normalized = String(value || '').replace(/\s+/gu, ' ').trim()
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}...`
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