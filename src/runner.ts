import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { findAdaptiveClickRecovery, findAdaptiveSelectorRecovery, isSelectorUnavailable } from './adaptive-recovery.js'
import { findUniqueHealingSelector, isPageReadStep, isScreenshotStep, isSafeBrowserTool } from './browser.js'
import { verifyPostClickExpectation } from './post-click-verification.js'
import { renderRunReport } from './report.js'
import { credentialReferenceName, redactLikelySecrets, untrustedPageData } from './security.js'
import { findAdaptiveClickPathPlan, findChecklistClickTargetForTask, resolveRecordedClickTask } from './structural-recovery.js'
import type {
  CheckpointStep,
  InspectionDefinition,
  JsonObject,
  JsonValue,
  ResumeState,
  RunArtifact,
  RunReport,
  SavedRunPaths,
  StepRunResult,
  TextExpectation,
  ToolStep,
} from './types.js'
import { PatrolStore } from './store.js'

export interface DispatchResult {
  ok: boolean
  text: string
  value?: JsonValue
  error?: string
}

export interface PatrolRunnerOptions {
  reportMaxChars: number
}

export class PatrolRunner {
  private readonly authorizedParents = new Map<ToolRunContext['token'], number>()

  constructor(
    private readonly ctx: Context,
    private readonly store: PatrolStore,
    private readonly options: PatrolRunnerOptions,
  ) {}

  isToolAllowed(name: string): boolean {
    return isSafeBrowserTool(name)
  }

  browserGuard(name: string, parent: ToolRunContext['token'] | undefined): string | undefined {
    if (!name.startsWith('browser_')) return undefined
    if (parent !== undefined && (this.authorizedParents.get(parent) ?? 0) > 0) return undefined
    return 'Direct browser_* calls are internal DSH Patrol primitives. Use the matching patrol_* recording tool (for clicks, patrol_click_target); it will dispatch browser_click inside an authorized composite so the action is recorded, verified, and replayable.'
  }

  async dispatch(tool: string, args: JsonObject, exec: ToolRunContext, exactSecrets: readonly string[] = []): Promise<DispatchResult> {
    if (!this.isToolAllowed(tool)) {
      return { ok: false, text: '', error: `tool ${tool} is not in DSH Patrol's exact browser allowlist` }
    }

    this.authorize(exec.token)
    let result: Awaited<ReturnType<typeof this.ctx.tools.execute>>
    try {
      result = await this.ctx.tools.execute({
        callId: CallId(`patrol-${randomUUID()}`),
        rootCallId: exec.rootCallId,
        name: tool,
        arguments: args,
        signal: exec.signal,
        ...(exec.agent === undefined ? {} : { agent: exec.agent }),
        parent: exec.token,
      })
    } finally {
      this.release(exec.token)
    }
    const text = redactLikelySecrets(
      result.content.map(block => block.type === 'text' ? block.text : `[${block.type}]`).join('\n'),
      exactSecrets,
    )
    if (result.isError) {
      return { ok: false, text, error: redactLikelySecrets(result.error.message, exactSecrets) }
    }

    const value = result.value as JsonValue
    const providerFailure = providerValueFailure(value)
    if (providerFailure !== undefined) {
      return { ok: false, text, value, error: redactLikelySecrets(providerFailure, exactSecrets) }
    }
    return { ok: true, text, value }
  }

  private authorize(token: ToolRunContext['token']): void {
    this.authorizedParents.set(token, (this.authorizedParents.get(token) ?? 0) + 1)
  }

  private release(token: ToolRunContext['token']): void {
    const count = this.authorizedParents.get(token) ?? 0
    if (count <= 1) this.authorizedParents.delete(token)
    else this.authorizedParents.set(token, count - 1)
  }

  async run(definition: InspectionDefinition, exec: ToolRunContext): Promise<{ report: RunReport; paths: SavedRunPaths }> {
    const pending = await this.store.loadResume(definition.id)
    if (pending !== undefined) {
      throw new Error(`inspection ${definition.id} has a pending checkpoint in run ${pending.runId}; use patrol_resume instead of starting a second run`)
    }
    await this.rememberInteractiveWorkspace(definition, exec)
    const startedAt = new Date().toISOString()
    const runId = `${startedAt.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
    return await this.executeFrom(definition, exec, {
      schemaVersion: '0.2',
      inspectionId: definition.id,
      runId,
      startedAt,
      definitionUpdatedAt: definition.metadata.updatedAt,
      nextStepIndex: 0,
      results: [],
    })
  }

  async resume(definition: InspectionDefinition, exec: ToolRunContext): Promise<{ report: RunReport; paths: SavedRunPaths }> {
    const state = await this.store.loadResume(definition.id)
    if (state === undefined) throw new Error(`inspection ${definition.id} has no pending checkpoint`)
    if (state.definitionUpdatedAt !== definition.metadata.updatedAt) {
      throw new Error(`inspection ${definition.id} changed after run ${state.runId} paused; abort the pending run before editing or starting over`)
    }
    await this.rememberInteractiveWorkspace(definition, exec)
    const results = state.results.map(result => result.status === 'waiting'
      ? { ...result, status: 'passed' as const, finishedAt: new Date().toISOString(), output: 'Checkpoint completed by the user before resume.' }
      : result)
    return await this.executeFrom(definition, exec, { ...state, results })
  }

  private async rememberInteractiveWorkspace(definition: InspectionDefinition, exec: ToolRunContext): Promise<void> {
    const workspaceRoot = exec.agent?.session.header.cwd
    if (workspaceRoot === undefined || workspaceRoot === definition.metadata.workspaceRoot) return
    definition.metadata.workspaceRoot = workspaceRoot
    await this.store.save(definition)
  }

  private async executeFrom(
    definition: InspectionDefinition,
    exec: ToolRunContext,
    state: ResumeState,
  ): Promise<{ report: RunReport; paths: SavedRunPaths }> {
    const results = [...state.results]
    const warnings: string[] = []
    let status: RunReport['status'] = 'passed'
    const outputWorkspace = exec.agent?.session.header.cwd ?? definition.metadata.workspaceRoot

    for (let index = state.nextStepIndex; index < definition.steps.length; index += 1) {
      const step = definition.steps[index]
      if (step === undefined) break
      const stepStartedAt = new Date().toISOString()

      if (step.when !== undefined && !conditionMatches(results, step.when)) {
        results.push({
          stepId: step.id,
          name: step.name,
          kind: step.kind,
          status: 'skipped',
          startedAt: stepStartedAt,
          finishedAt: new Date().toISOString(),
          output: `Condition on ${step.when.sourceStepId} was not satisfied.`,
        })
        continue
      }

      if (step.kind === 'checkpoint' && shouldSkipLegacyImageCodeCheckpoint(step, results)) {
        results.push({
          stepId: step.id,
          name: step.name,
          kind: 'checkpoint',
          status: 'skipped',
          startedAt: stepStartedAt,
          finishedAt: new Date().toISOString(),
          output: 'Legacy image-code checkpoint skipped because the immediately preceding successful detector already auto-filled the conventional image CAPTCHA.',
        })
        continue
      }

      if (step.kind === 'checkpoint') {
        results.push({
          stepId: step.id,
          name: step.name,
          kind: 'checkpoint',
          status: 'waiting',
          startedAt: stepStartedAt,
          finishedAt: new Date().toISOString(),
          output: step.prompt,
        })
        status = 'waiting'
        await this.store.saveResume({
          schemaVersion: '0.2',
          inspectionId: definition.id,
          runId: state.runId,
          startedAt: state.startedAt,
          definitionUpdatedAt: state.definitionUpdatedAt,
          nextStepIndex: index + 1,
          results,
        })
        break
      }

      const result = await this.executeToolStep(definition, state.runId, step, exec, stepStartedAt, outputWorkspace)
      results.push(result)
      if (result.status === 'failed') {
        status = 'failed'
        break
      }
    }

    if (status === 'passed'
      && definition.artifacts.some(item => item.toLowerCase() === 'screenshot')
      && !results.some(result => result.artifacts?.some(artifact => artifact.kind === 'screenshot'))) {
      const capturedAt = new Date().toISOString()
      const captured = await this.dispatch('browser_screenshot', {}, exec)
      if (!captured.ok) {
        const warning = `final screenshot artifact capture failed: ${captured.error ?? 'browser_screenshot failed'}`
        pushWarning(warnings, warning)
        results.push({
          stepId: 'artifact-final-screenshot',
          name: 'Final screenshot artifact',
          kind: 'tool',
          tool: 'browser_screenshot',
          status: 'skipped',
          startedAt: capturedAt,
          finishedAt: new Date().toISOString(),
          output: captured.text,
          error: warning,
        })
      } else {
        try {
          const providerPath = objectString(captured.value, 'path')
          if (providerPath === undefined) throw new Error('browser_screenshot returned no artifact path')
          const copied = await this.store.copyArtifact(
            definition.id,
            state.runId,
            providerPath,
            'final-screenshot',
            outputWorkspace,
          )
          results.push({
            stepId: 'artifact-final-screenshot',
            name: 'Final screenshot artifact',
            kind: 'tool',
            tool: 'browser_screenshot',
            status: 'passed',
            startedAt: capturedAt,
            finishedAt: new Date().toISOString(),
            output: 'Captured the final page state automatically because this inspection requires a screenshot artifact.',
            artifacts: [{ kind: 'screenshot', path: copied }],
          })
        } catch (error: unknown) {
          const warning = `final screenshot artifact persistence failed: ${errorMessage(error)}`
          pushWarning(warnings, warning)
          results.push({
            stepId: 'artifact-final-screenshot',
            name: 'Final screenshot artifact',
            kind: 'tool',
            tool: 'browser_screenshot',
            status: 'skipped',
            startedAt: capturedAt,
            finishedAt: new Date().toISOString(),
            output: captured.text,
            error: warning,
          })
        }
      }
    }

    const pageSummaryRequested = definition.artifacts.some(item => item.toLowerCase() === 'page-summary')
    const summary = status === 'waiting' || !pageSummaryRequested ? undefined : deterministicPageSummary(results)
    if (status === 'passed') {
      for (const result of results) {
        if (result.healedSelector !== undefined) {
          pushWarning(warnings, `Runbook step ${result.stepId} (${result.name}) recovered selector drift with ${result.healedSelector}; this healing candidate was used for this run only and was not persisted.`)
        }
        if (result.output?.includes('Adaptive replay inserted bounded checklist path')) {
          pushWarning(warnings, `Runbook step ${result.stepId} (${result.name}) inserted a bounded checklist recovery path for missing intermediate click tasks; this path was used for this run only and was not persisted.`)
        }
      }
      for (const warning of requiredArtifactWarnings(definition, results, summary)) pushWarning(warnings, warning)
    }
    if (status !== 'waiting') await this.store.clearResume(definition.id)
    const report: RunReport = {
      schemaVersion: '0.2',
      runId: state.runId,
      inspectionId: definition.id,
      inspectionName: definition.name,
      startedAt: state.startedAt,
      finishedAt: new Date().toISOString(),
      status,
      expectedResult: definition.expectedResult,
      results,
      ...(summary === undefined ? {} : { summary }),
      ...(warnings.length === 0 ? {} : { warnings }),
      ...(outputWorkspace === undefined ? {} : { outputWorkspace }),
    }
    const markdown = renderRunReport(report, this.options.reportMaxChars)
    const paths = await this.store.saveRun(report, markdown, outputWorkspace)
    return { report, paths }
  }

  private async executeToolStep(
    definition: InspectionDefinition,
    runId: string,
    step: ToolStep,
    exec: ToolRunContext,
    startedAt: string,
    outputWorkspace: string | undefined,
  ): Promise<StepRunResult> {
    let runtimeArguments: JsonObject
    try {
      runtimeArguments = prepareRuntimeArguments(step)
    } catch (error: unknown) {
      return failedResult(step, startedAt, errorMessage(error))
    }

    const reusedSession = await this.reuseAuthenticatedSession(definition, step, exec)
    if (reusedSession !== undefined) {
      return {
        stepId: step.id,
        name: step.name,
        kind: 'tool',
        tool: step.tool,
        status: 'passed',
        startedAt,
        finishedAt: new Date().toISOString(),
        output: reusedSession,
      }
    }

    let dispatched = await this.dispatch(step.tool, runtimeArguments, exec)
    let healedSelector: string | undefined
    let recoverySnapshot: DispatchResult | undefined
    let structuralRecoveryAdvanced = false

    if (!dispatched.ok && step.tool === 'browser_click' && step.locator !== undefined) {
      recoverySnapshot = await this.dispatch('browser_snapshot', {}, exec)
      if (recoverySnapshot.ok) {
        const candidate = findUniqueHealingSelector(recoverySnapshot.value, step.locator)
        if (candidate !== undefined) {
          const retried = await this.dispatch('browser_click', { ...runtimeArguments, selector: candidate }, exec)
          if (retried.ok) {
            dispatched = retried
            healedSelector = candidate
          }
        }
      }
    }

    if (!dispatched.ok
      && step.tool === 'browser_click'
      && isSelectorUnavailable(dispatched.error)) {
      recoverySnapshot ??= await this.dispatch('browser_snapshot', {}, exec)
      if (recoverySnapshot.ok) {
        const plan = findAdaptiveClickPathPlan(definition, step)
        if (plan !== undefined) {
          let currentSnapshot = recoverySnapshot
          const recoveredPath: string[] = []
          let structuralError: string | undefined

          for (const task of plan.missingTasks) {
            const target = findChecklistClickTargetForTask(definition, step, task, currentSnapshot.value)
            if (target === undefined) {
              structuralError = `CURRENT page did not expose one unique safe clickable target for missing checklist task ${JSON.stringify(task)}`
              break
            }

            const clicked = await this.dispatch(
              'browser_click',
              recoveryClickArguments(runtimeArguments, target.selector),
              exec,
            )
            if (!clicked.ok) {
              structuralError = `click for missing checklist task ${JSON.stringify(task)} failed: ${clicked.error ?? clicked.text ?? 'browser_click failed'}`
              break
            }

            structuralRecoveryAdvanced = true
            recoveredPath.push(`${task} -> ${target.selector}`)
            currentSnapshot = await this.dispatch('browser_snapshot', {}, exec)
            if (!currentSnapshot.ok) {
              structuralError = `could not inspect CURRENT page after recovering checklist task ${JSON.stringify(task)}: ${currentSnapshot.error ?? currentSnapshot.text ?? 'browser_snapshot failed'}`
              break
            }
          }

          if (structuralError === undefined) {
            const currentTarget = findChecklistClickTargetForTask(
              definition,
              step,
              plan.currentTask,
              currentSnapshot.value,
            )
            if (currentTarget === undefined) {
              structuralError = `recovered intermediate checklist tasks, but CURRENT page still did not expose one unique safe target for the recorded task ${JSON.stringify(plan.currentTask)}`
            } else {
              const retried = await this.dispatch(
                'browser_click',
                recoveryClickArguments(runtimeArguments, currentTarget.selector),
                exec,
              )
              if (retried.ok) {
                dispatched = {
                  ...retried,
                  text: [
                    retried.text,
                    'Adaptive replay inserted bounded checklist path before the current Runbook click.',
                    `Recovered path: ${recoveredPath.join(' ; ')}`,
                    `Current task: ${plan.currentTask} -> ${currentTarget.selector}`,
                    'The inserted path was run-local and was not persisted to the Runbook.',
                  ].filter(Boolean).join('\n'),
                }
                healedSelector = currentTarget.selector
                recoverySnapshot = currentSnapshot
              } else {
                structuralError = `CURRENT target for ${JSON.stringify(plan.currentTask)} was found after path recovery, but the click failed: ${retried.error ?? retried.text ?? 'browser_click failed'}`
              }
            }
          }

          if (!dispatched.ok && structuralRecoveryAdvanced && structuralError !== undefined) {
            dispatched = {
              ok: false,
              text: [
                dispatched.text,
                recoveredPath.length === 0 ? '' : `Adaptive replay recovered path prefix: ${recoveredPath.join(' ; ')}`,
                structuralError,
              ].filter(Boolean).join('\n'),
              error: `Adaptive checklist path recovery stopped fail-closed after advancing the CURRENT page: ${structuralError}`,
            }
          }
        }
      }
    }

    if (!dispatched.ok
      && !structuralRecoveryAdvanced
      && step.tool === 'browser_click'
      && isSelectorUnavailable(dispatched.error)) {
      recoverySnapshot ??= await this.dispatch('browser_snapshot', {}, exec)
      if (recoverySnapshot.ok) {
        const recordedTask = resolveRecordedClickTask(definition, step)
        const recovery = recordedTask === undefined
          ? findAdaptiveClickRecovery(definition, step, recoverySnapshot.value)
          : findChecklistClickTargetForTask(definition, step, recordedTask, recoverySnapshot.value)
        if (recovery !== undefined) {
          const retried = await this.dispatch('browser_click', { ...runtimeArguments, selector: recovery.selector }, exec)
          if (retried.ok) {
            dispatched = {
              ...retried,
              text: [
                retried.text,
                `Adaptive replay recovered the current click using ${recovery.reason}.`,
                recovery.task === undefined ? '' : `Task checklist: ${recovery.task}`,
              ].filter(Boolean).join('\n'),
            }
            healedSelector = recovery.selector
          }
        }
      }
    }

    if (!dispatched.ok
      && isSelectorUnavailable(dispatched.error)
      && ['browser_type', 'browser_type_credential'].includes(step.tool)) {
      const snapshot = await this.dispatch('browser_snapshot', {}, exec)
      if (snapshot.ok) {
        const recovery = findAdaptiveSelectorRecovery(definition, step, snapshot.value)
        if (recovery !== undefined) {
          const retried = await this.dispatch(step.tool, { ...runtimeArguments, selector: recovery.selector }, exec)
          if (retried.ok) {
            dispatched = {
              ...retried,
              text: [
                retried.text,
                `Adaptive replay recovered the current task using ${recovery.reason}.`,
                recovery.task === undefined ? '' : `Task checklist: ${recovery.task}`,
              ].filter(Boolean).join('\n'),
            }
            healedSelector = recovery.selector
          }
        }
      }
    }

    if (!dispatched.ok) {
      return {
        ...failedResult(step, startedAt, dispatched.error ?? 'Unknown browser tool error'),
        output: dispatched.text,
      }
    }

    let expectationError: string | undefined
    if (step.expectation !== undefined && step.tool === 'browser_click') {
      const tabId = typeof runtimeArguments.tabId === 'number' ? runtimeArguments.tabId : undefined
      const verified = await verifyPostClickExpectation(
        (toolName, toolArgs, toolExec) => this.dispatch(toolName, toolArgs, toolExec),
        exec,
        step.expectation,
        tabId,
      )
      expectationError = verified.ok ? undefined : verified.error
    } else if (step.expectation !== undefined) {
      expectationError = evaluateExpectation(dispatched.text, step.expectation)
    }

    if (expectationError !== undefined) {
      return {
        stepId: step.id,
        name: step.name,
        kind: 'tool',
        tool: step.tool,
        status: 'failed',
        startedAt,
        finishedAt: new Date().toISOString(),
        output: safeOutputForStep(step, dispatched.text),
        error: expectationError,
      }
    }

    const artifacts: RunArtifact[] = []
    try {
      if (isScreenshotStep(step)) {
        const providerPath = objectString(dispatched.value, 'path')
        if (providerPath === undefined) throw new Error('browser_screenshot returned no artifact path')
        const copied = await this.store.copyArtifact(definition.id, runId, providerPath, `${step.id}-screenshot`, outputWorkspace)
        artifacts.push({ kind: 'screenshot', path: copied })
      }
      if (isPageReadStep(step) && step.artifact === 'page-text') {
        const pageText = objectString(dispatched.value, 'text') ?? dispatched.text
        const saved = await this.store.saveTextArtifact(definition.id, runId, `${step.id}-page.txt`, redactLikelySecrets(pageText), outputWorkspace)
        artifacts.push({ kind: 'page-text', path: saved })
      }
    } catch (error: unknown) {
      return {
        stepId: step.id,
        name: step.name,
        kind: 'tool',
        tool: step.tool,
        status: 'failed',
        startedAt,
        finishedAt: new Date().toISOString(),
        output: safeOutputForStep(step, dispatched.text),
        error: `browser action succeeded but required artifact persistence failed: ${errorMessage(error)}`,
      }
    }

    return {
      stepId: step.id,
      name: step.name,
      kind: 'tool',
      tool: step.tool,
      status: 'passed',
      startedAt,
      finishedAt: new Date().toISOString(),
      output: safeOutputForStep(step, dispatched.text),
      ...(artifacts.length === 0 ? {} : { artifacts }),
      ...(healedSelector === undefined ? {} : { healedSelector }),
    }
  }

  private async reuseAuthenticatedSession(
    definition: InspectionDefinition,
    step: ToolStep,
    exec: ToolRunContext,
  ): Promise<string | undefined> {
    if (!looksLikeLoginStep(step)) return undefined
    const tabId = typeof step.arguments.tabId === 'number' ? step.arguments.tabId : undefined
    const state = await this.dispatch('browser_login_state', tabId === undefined ? {} : { tabId }, exec)
    if (!state.ok || objectString(state.value, 'state') !== 'authenticated') return undefined
    const url = objectString(state.value, 'url')
    if (url === undefined || !canReuseAuthenticatedSession(definition, url)) return undefined
    return `Existing authenticated managed-browser session detected at ${url} within this flow's known site scope. Reused the persistent Patrol browser profile and skipped this redundant login step; no cookie value was exposed or rewritten.`
  }
}

function prepareRuntimeArguments(step: ToolStep): JsonObject {
  if (step.tool !== 'browser_type_credential') {
    const refs: string[] = []
    collectCredentialPlaceholders(step.arguments, refs)
    if (refs.length > 0) {
      throw new Error(`credential references are only valid in browser_type_credential steps; found ${refs.join(', ')}`)
    }
    return step.arguments
  }

  const raw = step.arguments.credentialRef
  if (typeof raw !== 'string') throw new Error('browser_type_credential requires credentialRef')
  const ref = credentialReferenceName(raw) ?? (/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw) ? raw : undefined)
  if (ref === undefined) throw new Error('browser_type_credential credentialRef must be ${credential:REF} or a valid Harness credential reference name')
  return Object.fromEntries(Object.entries(step.arguments).filter(([key]) => key !== 'text').map(([key, value]) => [key, key === 'credentialRef' ? ref : value])) as JsonObject
}

function recoveryClickArguments(original: JsonObject, selector: string): JsonObject {
  const tabId = typeof original.tabId === 'number' ? original.tabId : undefined
  return tabId === undefined ? { selector } : { selector, tabId }
}

function looksLikeLoginStep(step: ToolStep): boolean {
  if (!['browser_type', 'browser_type_credential', 'browser_click'].includes(step.tool)) return false
  const hint = [
    step.name,
    typeof step.arguments.selector === 'string' ? step.arguments.selector : '',
    step.locator?.text ?? '',
    step.locator?.role ?? '',
    step.locator?.tag ?? '',
  ].join(' ')
  return /(login|log[-_ ]?in|sign[-_ ]?in|signin|password|passwd|pwd|username|user[-_ ]?name|登录|登陆|用户名|密码)/i.test(hint)
}

export function canReuseAuthenticatedSession(definition: InspectionDefinition, currentUrl: string): boolean {
  const currentOrigin = httpOrigin(currentUrl)
  if (currentOrigin === undefined) return false
  return knownFlowOrigins(definition).has(currentOrigin)
}

export function knownFlowOrigins(definition: InspectionDefinition): Set<string> {
  const origins = new Set<string>()
  const targetOrigin = httpOrigin(definition.target.url)
  if (targetOrigin !== undefined) origins.add(targetOrigin)
  for (const step of definition.steps) {
    if (step.kind !== 'tool' || step.tool !== 'browser_navigate') continue
    const url = typeof step.arguments.url === 'string' ? step.arguments.url : undefined
    const origin = url === undefined ? undefined : httpOrigin(url)
    if (origin !== undefined) origins.add(origin)
  }
  return origins
}

function httpOrigin(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.origin.toLocaleLowerCase('en-US')
  } catch {
    return undefined
  }
}

function collectCredentialPlaceholders(value: JsonValue, refs: string[]): void {
  if (typeof value === 'string') {
    const ref = credentialReferenceName(value)
    if (ref !== undefined) refs.push(ref)
    return
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return
  if (Array.isArray(value)) {
    for (const child of value) collectCredentialPlaceholders(child, refs)
    return
  }
  for (const child of Object.values(value)) collectCredentialPlaceholders(child, refs)
}

export function evaluateExpectation(text: string, expectation: TextExpectation): string | undefined {
  const haystack = expectation.caseSensitive ? text : text.toLocaleLowerCase()
  const needle = expectation.caseSensitive ? expectation.value : expectation.value.toLocaleLowerCase()
  const found = haystack.includes(needle)
  if (expectation.mode === 'contains' && !found) return `expected tool output to contain ${JSON.stringify(expectation.value)}`
  if (expectation.mode === 'not-contains' && found) return `expected tool output not to contain ${JSON.stringify(expectation.value)}`
  return undefined
}

export function conditionMatches(results: readonly StepRunResult[], condition: { sourceStepId: string } & TextExpectation): boolean {
  const source = [...results].reverse().find(item => item.stepId === condition.sourceStepId)
  if (source === undefined || source.status === 'failed' || source.status === 'waiting' || source.status === 'skipped') return false
  return evaluateExpectation(source.output ?? '', condition) === undefined
}

export function shouldSkipLegacyImageCodeCheckpoint(step: CheckpointStep, results: readonly StepRunResult[]): boolean {
  const detector = [...results].reverse().find(result => result.tool === 'browser_detect_auth_challenge' && result.status === 'passed')
  const output = detector?.output ?? ''
  if (!/\bobserved=captcha\/image-code\b/i.test(output)) return false
  if (!/\bkind=none\b/i.test(output) || !/\bhandoffRequired=false\b/i.test(output)) return false
  if (!/verification input auto-filled|auto-filled by the local Patrol solver/i.test(output)) return false

  const hint = [step.name, step.prompt, step.notes ?? ''].join(' ')
  if (/(otp|one[- ]?time|动态码|动态验证码|一次性|短信|手机验证码|邮箱验证码|邮件验证码|二次验证码|二次验证|secondary|device|设备|确认登录|passkey|二维码|recaptcha|hcaptcha|turnstile|arkose|funcaptcha)/i.test(hint)) {
    return false
  }
  return /(captcha|验证码|verification|human verification|人机验证)/i.test(hint)
}

export function deterministicPageSummary(results: readonly StepRunResult[]): string | undefined {
  const source = [...results].reverse().find(result => result.tool === 'browser_read_page' && result.status === 'passed' && result.output !== undefined)
  if (source?.output === undefined) return undefined
  const clean = source.output
    .replace(/^--- BEGIN UNTRUSTED PAGE DATA ---\n?/, '')
    .replace(/\n?--- END UNTRUSTED PAGE DATA ---$/, '')
    .split(/\r?\n/)
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  if (clean.length === 0) return '页面已读取，但没有可见文本。'
  const titleLine = clean[0]?.startsWith('Page:') ? clean.shift() : undefined
  const excerpt = clean.join(' · ').slice(0, 1600)
  return `${titleLine === undefined ? '' : `${titleLine}\n`}可见内容摘要（确定性摘录）：${excerpt}${clean.join(' · ').length > 1600 ? '…' : ''}`
}

function failedResult(step: ToolStep, startedAt: string, error: string): StepRunResult {
  return {
    stepId: step.id,
    name: step.name,
    kind: 'tool',
    tool: step.tool,
    status: 'failed',
    startedAt,
    finishedAt: new Date().toISOString(),
    error: redactLikelySecrets(error),
  }
}

function providerValueFailure(value: JsonValue): string | undefined {
  if (value === null || Array.isArray(value) || typeof value !== 'object') return undefined
  if (value.ok === false) {
    return typeof value.error === 'string' && value.error.length > 0 ? value.error : 'browser provider returned ok=false'
  }
  return undefined
}

function objectString(value: JsonValue | undefined, key: string): string | undefined {
  if (value === undefined || value === null || Array.isArray(value) || typeof value !== 'object') return undefined
  const candidate = value[key]
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined
}

function safeOutputForStep(step: ToolStep, text: string): string {
  const redacted = redactLikelySecrets(text)
  return step.tool === 'browser_read_page' || step.tool === 'browser_snapshot'
    ? untrustedPageData(redacted)
    : redacted
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function pushWarning(warnings: string[], warning: string): void {
  const redacted = redactLikelySecrets(warning)
  if (!warnings.includes(redacted)) warnings.push(redacted)
}

export function requiredArtifactWarnings(
  definition: InspectionDefinition,
  results: readonly StepRunResult[],
  summary: string | undefined,
): string[] {
  const requested = new Set(definition.artifacts.map(item => item.toLowerCase()))
  const artifacts = results.flatMap(result => result.artifacts ?? [])
  const warnings: string[] = []
  if (requested.has('screenshot') && !artifacts.some(artifact => artifact.kind === 'screenshot')) {
    warnings.push('inspection requested a screenshot, but no screenshot artifact was produced')
  }
  if (requested.has('page-text') && !artifacts.some(artifact => artifact.kind === 'page-text')) {
    warnings.push('inspection requested page-text, but no page-text artifact was produced')
  }
  if (requested.has('page-summary') && summary === undefined) {
    warnings.push('inspection requested page-summary, but no successful browser_read_page output was available to summarize')
  }
  return warnings
}
