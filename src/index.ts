import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { PATROL_SYSTEM_PROMPT } from './prompt.ts'
import { PatrolRunner } from './runner.ts'
import { PatrolStore } from './store.ts'
import { registerPatrolTools } from './tools.ts'

export * from './types.ts'
export { PatrolStore } from './store.ts'
export { PatrolRunner, evaluateExpectation } from './runner.ts'

export const name = 'dsh-patrol'
export const inject = ['tools']

const DEFAULT_STORAGE_PATH = dshHomePath('patrol')
const DEFAULT_ALLOWED_TOOL_PREFIXES = ['browser_']
const DEFAULT_MAX_STEPS = 200
const DEFAULT_REPORT_MAX_CHARS = 30_000

export interface Config {
  storagePath?: string
  allowedToolPrefixes?: string[]
  maxSteps?: number
  reportMaxChars?: number
}

export const Config: z<Config> = z.object({
  storagePath: z.string().default(DEFAULT_STORAGE_PATH),
  allowedToolPrefixes: z.array(z.string()).default(DEFAULT_ALLOWED_TOOL_PREFIXES),
  maxSteps: z.number().step(1).min(1).default(DEFAULT_MAX_STEPS),
  reportMaxChars: z.number().step(1).min(1000).default(DEFAULT_REPORT_MAX_CHARS),
})

interface ResolvedConfig {
  storagePath: string
  allowedToolPrefixes: string[]
  maxSteps: number
  reportMaxChars: number
}

export function resolveConfig(config: Config): ResolvedConfig {
  const resolved: ResolvedConfig = {
    storagePath: config.storagePath ?? DEFAULT_STORAGE_PATH,
    allowedToolPrefixes: [...(config.allowedToolPrefixes ?? DEFAULT_ALLOWED_TOOL_PREFIXES)],
    maxSteps: config.maxSteps ?? DEFAULT_MAX_STEPS,
    reportMaxChars: config.reportMaxChars ?? DEFAULT_REPORT_MAX_CHARS,
  }
  if (resolved.allowedToolPrefixes.length === 0 || resolved.allowedToolPrefixes.some(prefix => prefix.length === 0)) {
    throw new Error('dsh-patrol: allowedToolPrefixes must contain at least one non-empty prefix')
  }
  if (resolved.allowedToolPrefixes.some(prefix => 'patrol_'.startsWith(prefix) || prefix.startsWith('patrol_'))) {
    throw new Error('dsh-patrol: allowedToolPrefixes must not permit patrol_* recursion')
  }
  if (!Number.isInteger(resolved.maxSteps) || resolved.maxSteps < 1) throw new Error('dsh-patrol: maxSteps must be a positive integer')
  if (!Number.isInteger(resolved.reportMaxChars) || resolved.reportMaxChars < 1000) throw new Error('dsh-patrol: reportMaxChars must be an integer >= 1000')
  return resolved
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = resolveConfig(config)
  const store = new PatrolStore(resolved.storagePath)
  await store.init()
  const runner = new PatrolRunner(ctx, store, {
    allowedToolPrefixes: resolved.allowedToolPrefixes,
    reportMaxChars: resolved.reportMaxChars,
  })

  ctx.effect(
    () => registerPatrolTools(ctx, store, runner, { maxSteps: resolved.maxSteps }),
    'dsh-patrol: patrol tools',
  )

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined) {
    ctx.effect(() => systemPrompt.section({
      name: 'agent:dsh-patrol',
      order: 130,
      text: PATROL_SYSTEM_PROMPT,
    }), 'dsh-patrol: agent workflow prompt')
  }

  ctx.logger.info(`dsh-patrol ready; storage=${resolved.storagePath}; allowlist=${resolved.allowedToolPrefixes.join(',')}`)
}
