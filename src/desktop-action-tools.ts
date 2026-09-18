import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { applyDesktopTargetDefaults, DESKTOP_ACTIONS, desktopArtifactForTool, desktopToolForAction, type DesktopAction } from './desktop.js'
import { assertSafeForStorage, assertSafePersistentText } from './security.js'
import { PatrolRunner } from './runner.js'
import { assertPersistedTaskChecklist, PatrolStore } from './store.js'
import type { InspectionDefinition, InspectionStep, JsonObject, RunArtifact, ToolStep } from './types.js'

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

export interface PatrolDesktopActionToolsOptions {
  maxSteps: number
}

interface TeachingResultRecorder {
  recordTeachingStepResult?: (
    inspectionId: string,
    stepId: string,
    update: { output?: string; artifacts?: RunArtifact[]; pageText?: string },
  ) => Promise<RunArtifact[]>
}

export function registerPatrolDesktopActionTools(
  ctx: Context,
  store: PatrolStore,
  runner: PatrolRunner,
  options: PatrolDesktopActionToolsOptions,
): () => void {
  const desktopAction = defineTool({
    name: 'patrol_desktop_action',
    description: 'Execute and record one Windows Desktop Automation action using flat parameters. Desktop strategy is CURRENT OCR/keyboard > proven UI Automation > CURRENT coordinate fallback. Current permission policy is intentionally unrestricted in both TEST and NORMAL modes. Once a desktop Patrol inspection/checklist exists, successful business actions must use this tool so the Runbook and visual flow diagram are populated; raw desktop_* tools remain live exploration/diagnostic helpers.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      stepName: { type: 'string', required: true },
      action: { type: 'string', required: true, enum: [...DESKTOP_ACTIONS] },
      file: { type: 'string' },
      app: { type: 'string' },
      arguments: { type: 'array', items: { type: 'string' } },
      workingDirectory: { type: 'string' },
      path: { type: 'string' },
      processName: { type: 'string' },
      title: { type: 'string' },
      titleContains: { type: 'string' },
      maxElements: { type: 'integer' },
      includeOffscreen: { type: 'boolean' },
      name: { type: 'string' },
      automationId: { type: 'string' },
      controlType: { type: 'string' },
      className: { type: 'string' },
      match: { type: 'string', enum: ['exact', 'contains'] },
      caseSensitive: { type: 'boolean' },
      requireUnique: { type: 'boolean' },
      source: { type: 'string', enum: ['auto', 'uia', 'ocr'] },
      timeoutMs: { type: 'integer' },
      pollMs: { type: 'integer' },
      index: { type: 'integer' },
      x: { type: 'integer' },
      y: { type: 'integer' },
      button: { type: 'string', enum: ['left', 'right'] },
      fromX: { type: 'integer' },
      fromY: { type: 'integer' },
      toX: { type: 'integer' },
      toY: { type: 'integer' },
      durationMs: { type: 'integer' },
      text: { type: 'string' },
      value: { type: 'string', description: 'Optional non-secret UIA ValuePattern value selector for wait-for-target.' },
      clear: { type: 'boolean' },
      combo: { type: 'string' },
      key: { type: 'string' },
      milliseconds: { type: 'integer' },
      scope: { type: 'string', enum: ['active-window', 'screen'] },
      captureMethod: { type: 'string', enum: ['auto', 'print-window', 'screen'] },
      minXRatio: { type: 'number' },
      maxXRatio: { type: 'number' },
      minYRatio: { type: 'number' },
      maxYRatio: { type: 'number' },
      fileName: { type: 'string' },
      languages: { type: 'array', items: { type: 'string' }, description: 'Optional OCR language passes for action=ocr, click-ocr-text, or wait-for-target.' },
      paths: { type: 'array', items: { type: 'string' } },
      storedPaths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional replay-only paths. For a browser-to-desktop screenshot handoff, execute with the CURRENT screenshot path in paths and persist storedPaths=["${artifact:last-screenshot}"].',
      },
      recursive: { type: 'boolean' },
      notes: { type: 'string' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const action = args.action as DesktopAction
      const tool = desktopToolForAction(action)
      const executionArgs = desktopArguments(action, args, false)
      const storedArgs = desktopArguments(action, args, true)
      return await executeAndRecordDesktopAction(
        store,
        runner,
        options.maxSteps,
        exec,
        args.inspectionId,
        args.stepName,
        tool,
        executionArgs,
        storedArgs,
        args.notes,
      )
    },
  })

  const disposers = [ctx.tools.register(desktopAction)]
  return () => { for (const dispose of disposers) dispose() }
}

async function executeAndRecordDesktopAction(
  store: PatrolStore,
  runner: PatrolRunner,
  maxSteps: number,
  exec: ToolRunContext,
  inspectionId: string,
  stepName: string,
  tool: string,
  executionArgs: JsonObject,
  storedArgs: JsonObject,
  notes: string | undefined,
): Promise<string> {
  assertSafePersistentText(stepName, 'stepName')
  if (notes !== undefined) assertSafePersistentText(notes, 'step notes')
  const definition = await loadEditable(store, inspectionId, maxSteps)
  const effectiveExecutionArgs = applyDesktopTargetDefaults(definition, tool, executionArgs)
  const effectiveStoredArgs = applyDesktopTargetDefaults(definition, tool, storedArgs)
  assertSafeForStorage(effectiveStoredArgs)

  const dispatched = await runner.dispatch(tool, effectiveExecutionArgs, exec)
  if (!dispatched.ok) {
    return `Desktop teaching action failed and was NOT recorded. ${dispatched.error ?? dispatched.text ?? 'Unknown desktop error'}`
  }

  const artifact = desktopArtifactForTool(tool)
  const step: ToolStep = {
    id: nextStepId(definition.steps),
    kind: 'tool',
    name: stepName,
    tool,
    arguments: effectiveStoredArgs,
    ...(artifact === undefined ? {} : { artifact }),
    ...(notes === undefined ? {} : { notes }),
    recordedAt: new Date().toISOString(),
  }
  definition.steps.push(step)
  definition.schemaVersion = '0.2'
  definition.metadata.updatedAt = new Date().toISOString()
  delete definition.metadata.flowHealth
  await store.save(definition)

  let output = dispatched.text
  const teachingArtifacts: RunArtifact[] = []
  if (tool === 'desktop_screenshot') {
    const providerPath = objectString(dispatched.value, 'path')
    const workspaceRoot = exec.agent?.session.header.cwd
    if (providerPath !== undefined && workspaceRoot !== undefined && workspaceRoot.trim() !== '') {
      try {
        const organizedPath = await store.organizeTeachingScreenshot(inspectionId, providerPath, workspaceRoot)
        teachingArtifacts.push({ kind: 'screenshot', path: organizedPath })
        output = output.includes(providerPath)
          ? output.split(providerPath).join(organizedPath)
          : `${output}\nPatrol workspace desktop screenshot: ${organizedPath}`
      } catch (error: unknown) {
        output = `${output}\nDesktop screenshot organization warning: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  }

  await (store as TeachingResultRecorder).recordTeachingStepResult?.(inspectionId, step.id, {
    output,
    ...(teachingArtifacts.length === 0 ? {} : { artifacts: teachingArtifacts }),
  })
  return `Executed and recorded ${step.id} (${tool}).\n${output}`
}

function desktopArguments(action: DesktopAction, args: Record<string, unknown>, persisted: boolean): JsonObject {
  const out: JsonObject = {}
  const add = (key: string, value: unknown) => {
    if (value === undefined) return
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = value
    else if (Array.isArray(value) && value.every(item => typeof item === 'string')) out[key] = [...value] as string[]
  }

  switch (action) {
    case 'launch-app':
      add('file', args.file); add('app', args.app); add('arguments', args.arguments); add('workingDirectory', args.workingDirectory); break
    case 'open-path':
      add('path', args.path); break
    case 'activate-window':
      add('processName', args.processName); add('title', args.title); add('titleContains', args.titleContains); break
    case 'snapshot':
      add('processName', args.processName); add('title', args.title); add('titleContains', args.titleContains)
      add('maxElements', args.maxElements); add('includeOffscreen', args.includeOffscreen); break
    case 'click-target':
      add('processName', args.processName); add('title', args.title); add('titleContains', args.titleContains)
      add('name', args.name); add('automationId', args.automationId); add('controlType', args.controlType); add('className', args.className)
      add('match', args.match); add('index', args.index); break
    case 'click-ocr-text':
      add('processName', args.processName); add('title', args.title); add('titleContains', args.titleContains)
      add('text', args.text); add('match', args.match); add('caseSensitive', args.caseSensitive); add('index', args.index)
      add('button', args.button); add('scope', args.scope); add('captureMethod', args.captureMethod); add('languages', args.languages)
      add('minXRatio', args.minXRatio); add('maxXRatio', args.maxXRatio); add('minYRatio', args.minYRatio); add('maxYRatio', args.maxYRatio)
      add('fileName', args.fileName); break
    case 'click-coordinates':
      add('x', args.x); add('y', args.y); add('button', args.button); break
    case 'drag':
      add('fromX', args.fromX); add('fromY', args.fromY); add('toX', args.toX); add('toY', args.toY); add('durationMs', args.durationMs); break
    case 'type-text':
      add('processName', args.processName); add('title', args.title); add('titleContains', args.titleContains)
      add('text', args.text); add('clear', args.clear); break
    case 'type-target':
      add('processName', args.processName); add('title', args.title); add('titleContains', args.titleContains)
      add('name', args.name); add('automationId', args.automationId); add('controlType', args.controlType); add('className', args.className)
      add('match', args.match); add('index', args.index); add('text', args.text); add('clear', args.clear); break
    case 'paste-target':
      add('processName', args.processName); add('title', args.title); add('titleContains', args.titleContains)
      add('name', args.name); add('automationId', args.automationId); add('controlType', args.controlType); add('className', args.className)
      add('match', args.match); add('index', args.index); break
    case 'press-target':
      add('processName', args.processName); add('title', args.title); add('titleContains', args.titleContains)
      add('name', args.name); add('automationId', args.automationId); add('controlType', args.controlType); add('className', args.className)
      add('match', args.match); add('index', args.index); add('key', args.key); break
    case 'hotkey':
      add('processName', args.processName); add('title', args.title); add('titleContains', args.titleContains)
      add('combo', args.combo); break
    case 'press':
      add('processName', args.processName); add('title', args.title); add('titleContains', args.titleContains)
      add('key', args.key); break
    case 'wait':
      add('milliseconds', args.milliseconds); break
    case 'wait-for-target':
      add('source', args.source); add('processName', args.processName); add('title', args.title); add('titleContains', args.titleContains)
      add('name', args.name); add('automationId', args.automationId); add('controlType', args.controlType); add('className', args.className); add('value', args.value)
      add('text', args.text); add('match', args.match); add('caseSensitive', args.caseSensitive); add('requireUnique', args.requireUnique)
      add('scope', args.scope); add('captureMethod', args.captureMethod); add('languages', args.languages)
      add('minXRatio', args.minXRatio); add('maxXRatio', args.maxXRatio); add('minYRatio', args.minYRatio); add('maxYRatio', args.maxYRatio)
      add('maxElements', args.maxElements); add('timeoutMs', args.timeoutMs); add('pollMs', args.pollMs); break
    case 'screenshot':
      add('scope', args.scope); add('captureMethod', args.captureMethod); add('processName', args.processName); add('title', args.title); add('titleContains', args.titleContains)
      add('fileName', args.fileName); break
    case 'ocr':
      add('scope', args.scope); add('captureMethod', args.captureMethod); add('processName', args.processName); add('title', args.title); add('titleContains', args.titleContains)
      add('fileName', args.fileName); add('languages', args.languages); break
    case 'set-clipboard-text':
      add('text', args.text); break
    case 'set-clipboard-files':
      add('paths', persisted && Array.isArray(args.storedPaths) ? args.storedPaths : args.paths); break
    case 'paste':
      add('processName', args.processName); add('title', args.title); add('titleContains', args.titleContains); break
    case 'close-window':
      add('processName', args.processName); add('title', args.title); add('titleContains', args.titleContains); break
    case 'delete-path':
      add('path', args.path); add('recursive', args.recursive); break
  }

  validateRequiredDesktopArguments(action, out)
  return out
}

function validateRequiredDesktopArguments(action: DesktopAction, args: JsonObject): void {
  const requireText = (key: string) => {
    if (typeof args[key] !== 'string' || String(args[key]).trim() === '') throw new Error(`${action} requires ${key}`)
  }
  const requireNumber = (key: string) => {
    if (typeof args[key] !== 'number' || !Number.isInteger(args[key] as number)) throw new Error(`${action} requires integer ${key}`)
  }
  const requireRange = (key: string, min: number, max: number) => {
    requireNumber(key)
    const value = args[key] as number
    if (value < min || value > max) throw new Error(`${action} ${key} must be between ${min} and ${max}`)
  }
  switch (action) {
    case 'launch-app':
      if (![args.file, args.app].some(value => typeof value === 'string' && value.trim() !== '')) throw new Error('launch-app requires file or app')
      break
    case 'open-path':
    case 'delete-path': requireText('path'); break
    case 'click-target':
      if (typeof args.name !== 'string'
        && typeof args.automationId !== 'string'
        && typeof args.controlType !== 'string'
        && typeof args.className !== 'string') {
        throw new Error('click-target requires name, automationId, controlType, or className')
      }
      break
    case 'click-ocr-text': requireText('text'); break
    case 'click-coordinates': requireNumber('x'); requireNumber('y'); break
    case 'drag': requireNumber('fromX'); requireNumber('fromY'); requireNumber('toX'); requireNumber('toY'); break
    case 'type-text':
    case 'set-clipboard-text': requireText('text'); break
    case 'type-target':
      requireText('text')
      if (![args.name, args.automationId, args.controlType, args.className]
        .some(value => typeof value === 'string' && value.trim() !== '')) {
        throw new Error('type-target requires name, automationId, controlType, or className')
      }
      break
    case 'paste-target':
      if (![args.name, args.automationId, args.controlType, args.className]
        .some(value => typeof value === 'string' && value.trim() !== '')) {
        throw new Error('paste-target requires name, automationId, controlType, or className')
      }
      break
    case 'press-target':
      requireText('key')
      if (![args.name, args.automationId, args.controlType, args.className]
        .some(value => typeof value === 'string' && value.trim() !== '')) {
        throw new Error('press-target requires name, automationId, controlType, or className')
      }
      break
    case 'hotkey': requireText('combo'); break
    case 'press': requireText('key'); break
    case 'wait': requireNumber('milliseconds'); break
    case 'wait-for-target':
      if (![args.name, args.automationId, args.controlType, args.className, args.value, args.text]
        .some(value => typeof value === 'string' && value.trim() !== '')) {
        throw new Error('wait-for-target requires text or a UI Automation selector')
      }
      if (args.source === 'ocr') requireText('text')
      if (args.timeoutMs !== undefined) requireRange('timeoutMs', 100, 120000)
      if (args.pollMs !== undefined) requireRange('pollMs', 100, 5000)
      if (args.maxElements !== undefined) requireRange('maxElements', 1, 1000)
      break
    case 'set-clipboard-files':
      if (!Array.isArray(args.paths) || args.paths.length === 0) throw new Error('set-clipboard-files requires paths')
      break
    default:
      break
  }
}

async function loadEditable(store: PatrolStore, inspectionId: string, maxSteps: number): Promise<InspectionDefinition> {
  const definition = await store.load(inspectionId)
  if (definition.status !== 'draft') throw new Error(`inspection ${definition.id} is ${definition.status}, not draft; call patrol_begin_edit for an existing saved Runbook`)
  assertPersistedTaskChecklist(definition)
  if (definition.steps.length >= maxSteps) throw new Error(`runbook reached maxSteps=${maxSteps}`)
  return definition
}

function nextStepId(steps: readonly InspectionStep[]): string {
  let max = 0
  for (const step of steps) {
    const match = /^step-(\d+)$/.exec(step.id)
    if (match !== null) max = Math.max(max, Number.parseInt(match[1] ?? '0', 10))
  }
  return `step-${String(max + 1).padStart(3, '0')}`
}

function objectString(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const child = (value as Record<string, unknown>)[key]
  return typeof child === 'string' && child.length > 0 ? child : undefined
}
