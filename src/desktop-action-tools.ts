import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { DESKTOP_ACTIONS, desktopArtifactForTool, desktopToolForAction, type DesktopAction } from './desktop.js'
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
    description: 'Execute and record one Windows Desktop Automation action using flat parameters. Desktop strategy is UI Automation > keyboard > OCR > CURRENT coordinate fallback. Current permission policy is intentionally unrestricted in both TEST and NORMAL modes. Use raw desktop_* tools for live exploration; use this patrol_* tool when the action should become part of a reusable Runbook.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      stepName: { type: 'string', required: true },
      action: { type: 'string', required: true, enum: [...DESKTOP_ACTIONS] },
      file: { type: 'string' },
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
      match: { type: 'string', enum: ['exact', 'contains'] },
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
      clear: { type: 'boolean' },
      combo: { type: 'string' },
      key: { type: 'string' },
      milliseconds: { type: 'integer' },
      scope: { type: 'string', enum: ['active-window', 'screen'] },
      fileName: { type: 'string' },
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
  assertSafeForStorage(storedArgs)
  const definition = await loadEditable(store, inspectionId, maxSteps)

  const dispatched = await runner.dispatch(tool, executionArgs, exec)
  if (!dispatched.ok) {
    return `Desktop teaching action failed and was NOT recorded. ${dispatched.error ?? dispatched.text ?? 'Unknown desktop error'}`
  }

  const step: ToolStep = {
    id: nextStepId(definition.steps),
    kind: 'tool',
    name: stepName,
    tool,
    arguments: storedArgs,
    ...(desktopArtifactForTool(tool) === undefined ? {} : { artifact: desktopArtifactForTool(tool) }),
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
      add('file', args.file); add('arguments', args.arguments); add('workingDirectory', args.workingDirectory); break
    case 'open-path':
      add('path', args.path); break
    case 'activate-window':
      add('processName', args.processName); add('title', args.title); add('titleContains', args.titleContains); break
    case 'snapshot':
      add('processName', args.processName); add('title', args.title); add('titleContains', args.titleContains)
      add('maxElements', args.maxElements); add('includeOffscreen', args.includeOffscreen); break
    case 'click-target':
      add('processName', args.processName); add('title', args.title); add('titleContains', args.titleContains)
      add('name', args.name); add('automationId', args.automationId); add('controlType', args.controlType)
      add('match', args.match); add('index', args.index); break
    case 'click-coordinates':
      add('x', args.x); add('y', args.y); add('button', args.button); break
    case 'drag':
      add('fromX', args.fromX); add('fromY', args.fromY); add('toX', args.toX); add('toY', args.toY); add('durationMs', args.durationMs); break
    case 'type-text':
      add('text', args.text); add('clear', args.clear); break
    case 'hotkey':
      add('combo', args.combo); break
    case 'press':
      add('key', args.key); break
    case 'wait':
      add('milliseconds', args.milliseconds); break
    case 'screenshot':
    case 'ocr':
      add('scope', args.scope); add('processName', args.processName); add('title', args.title); add('titleContains', args.titleContains)
      add('fileName', args.fileName); break
    case 'set-clipboard-text':
      add('text', args.text); break
    case 'set-clipboard-files':
      add('paths', persisted && Array.isArray(args.storedPaths) ? args.storedPaths : args.paths); break
    case 'paste':
      break
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
  switch (action) {
    case 'launch-app': requireText('file'); break
    case 'open-path':
    case 'delete-path': requireText('path'); break
    case 'click-target':
      if (typeof args.name !== 'string' && typeof args.automationId !== 'string') throw new Error('click-target requires name or automationId')
      break
    case 'click-coordinates': requireNumber('x'); requireNumber('y'); break
    case 'drag': requireNumber('fromX'); requireNumber('fromY'); requireNumber('toX'); requireNumber('toY'); break
    case 'type-text':
    case 'set-clipboard-text': requireText('text'); break
    case 'hotkey': requireText('combo'); break
    case 'press': requireText('key'); break
    case 'wait': requireNumber('milliseconds'); break
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
