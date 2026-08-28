import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { registerPatrolActionTools } from './action-tools.js'
import { registerPatrolCreationTools } from './creation-tools.js'
import { registerPatrolCredentialTools } from './credential-tools.js'
import { registerPatrolEditTools } from './edit-tools.js'
import { PATROL_EXCEL_PROMPT, registerPatrolExcelTools } from './excel-tools.js'
import { registerPatrolHandoffTools } from './handoff-tools.js'
import { PATROL_SYSTEM_PROMPT } from './prompt.js'
import { PatrolRunner } from './runner.js'
import { PatrolScheduler, registerPatrolScheduleTools } from './scheduler.js'
import { PATROL_SESSION_PROMPT } from './session-prompt.js'
import { PatrolStore } from './store.js'
import { registerPatrolTools } from './tools.js'
import { registerPatrolWorkspaceTools } from './workspace-tools.js'

export * from './types.js'
export * from './browser.js'
export * from './security.js'
export * from './scheduler.js'
export * from './edit-tools.js'
export * from './action-tools.js'
export * from './creation-tools.js'
export * from './credential-tools.js'
export * from './excel-tools.js'
export * from './handoff-tools.js'
export { PatrolStore } from './store.js'
export { PatrolRunner, conditionMatches, evaluateExpectation } from './runner.js'

export const name = 'dsh-patrol'
export const inject = ['tools']

const DEFAULT_STORAGE_PATH = resolve(process.cwd(), '.dsh-patrol')
const DEFAULT_MAX_STEPS = 200
const DEFAULT_REPORT_MAX_CHARS = 30_000

export interface Config {
  storagePath?: string
  maxSteps?: number
  reportMaxChars?: number
  /** Deprecated v0.1 compatibility; Patrol v0.2 uses an exact safe-browser allowlist. */
  allowedToolPrefixes?: string[]
}

export const Config: z<Config> = z.object({
  storagePath: z.string().default(DEFAULT_STORAGE_PATH),
  maxSteps: z.number().step(1).min(1).default(DEFAULT_MAX_STEPS),
  reportMaxChars: z.number().step(1).min(1000).default(DEFAULT_REPORT_MAX_CHARS),
  allowedToolPrefixes: z.array(z.string()).default(['browser_']),
})

interface ResolvedConfig {
  storagePath: string
  maxSteps: number
  reportMaxChars: number
}

export function resolveConfig(config: Config): ResolvedConfig {
  const resolved: ResolvedConfig = {
    storagePath: resolve(config.storagePath ?? DEFAULT_STORAGE_PATH),
    maxSteps: config.maxSteps ?? DEFAULT_MAX_STEPS,
    reportMaxChars: config.reportMaxChars ?? DEFAULT_REPORT_MAX_CHARS,
  }
  if (!Number.isInteger(resolved.maxSteps) || resolved.maxSteps < 1) throw new Error('dsh-patrol: maxSteps must be a positive integer')
  if (!Number.isInteger(resolved.reportMaxChars) || resolved.reportMaxChars < 1000) throw new Error('dsh-patrol: reportMaxChars must be an integer >= 1000')
  if (config.allowedToolPrefixes !== undefined
    && (config.allowedToolPrefixes.length !== 1 || config.allowedToolPrefixes[0] !== 'browser_')) {
    throw new Error('dsh-patrol: allowedToolPrefixes is deprecated and may only remain ["browser_"]; v0.2 uses an exact internal allowlist')
  }
  return resolved
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = resolveConfig(config)
  const store = new PatrolStore(resolved.storagePath)
  await store.init()
  const runner = new PatrolRunner(ctx, store, { reportMaxChars: resolved.reportMaxChars })

  ctx.effect(
    () => registerPatrolTools(ctx, store, runner, {
      maxSteps: resolved.maxSteps,
      reportMaxChars: resolved.reportMaxChars,
    }),
    'dsh-patrol: patrol tools',
  )
  ctx.effect(() => registerPatrolCreationTools(ctx, store), 'dsh-patrol: secret-safe inspection creation')
  ctx.effect(() => registerPatrolCredentialTools(ctx, store), 'dsh-patrol: credential setup guidance')
  ctx.effect(
    () => registerPatrolActionTools(ctx, store, runner, { maxSteps: resolved.maxSteps }),
    'dsh-patrol: flat browser action tools',
  )
  ctx.effect(
    () => registerPatrolHandoffTools(ctx, store, runner, { maxSteps: resolved.maxSteps }),
    'dsh-patrol: human verification handoff tools',
  )
  ctx.effect(() => registerPatrolEditTools(ctx, store, runner), 'dsh-patrol: runbook edit and validation tools')
  ctx.effect(() => registerPatrolWorkspaceTools(ctx, store), 'dsh-patrol: workspace path tools')
  ctx.effect(() => registerPatrolExcelTools(ctx), 'dsh-patrol: adaptive workspace Excel tools')
  ctx.effect(() => registerPatrolScheduleTools(ctx, store), 'dsh-patrol: schedule tools')

  const scheduler = new PatrolScheduler(ctx, store)
  ctx.effect(() => scheduler.start(), 'dsh-patrol: scheduled patrol runner')

  // Browser provider tools live in the Patrol preset so nested dispatch can use
  // them, but model-direct browser calls would bypass recording. Deny only root
  // calls; Patrol's nested calls carry the outer patrol_* execution token.
  ctx.effect(
    () => ctx.tools.guard(execution => runner.browserGuard(execution.name, execution.parent)),
    'dsh-patrol: deny direct model browser calls',
  )

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined) {
    ctx.effect(() => systemPrompt.section({
      name: 'agent:dsh-patrol',
      order: 130,
      text: PATROL_SYSTEM_PROMPT,
    }), 'dsh-patrol: agent workflow prompt')
    ctx.effect(() => systemPrompt.section({
      name: 'agent:dsh-patrol-excel',
      order: 131,
      text: PATROL_EXCEL_PROMPT,
    }), 'dsh-patrol: adaptive Excel workflow prompt')
    ctx.effect(() => systemPrompt.section({
      name: 'agent:dsh-patrol-session',
      order: 132,
      text: PATROL_SESSION_PROMPT,
    }), 'dsh-patrol: authenticated-session reuse prompt')
  }

  ctx.logger.info(`dsh-patrol ready; internal state=${resolved.storagePath}; user outputs=session workspace; scheduler=enabled; credential helper=enabled; verification handoff=enabled; secret-safe creation=enabled; flat action tools=enabled; adaptive Excel tools=enabled; editable runbooks=enabled; persistent-session reuse=enabled; exact browser allowlist enabled`)
}
