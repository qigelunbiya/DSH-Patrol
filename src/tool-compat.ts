/**
 * Compatibility bridge for the Harness tool-execution API.
 *
 * Harness 0.1.x exposes a single-call contract:
 *   `ctx.tools.execute({ callId, rootCallId, name, arguments, signal, agent?, parent })`
 * returning one result object.
 *
 * Harness 0.2.x replaced it with a batch contract:
 *   `ctx.tools.execute({ calls, signal, agent?, log? })`
 * returning `{ results: [{ callId, result }], additionalContexts, concluded }`,
 * and renamed the `CallId` brand to `ToolCallId` in the same release.
 *
 * DSH Patrol records and replays exactly one primitive call at a time, so this
 * module adapts both generations back to the single-result shape the runner,
 * scheduler and observation tools already consume. Both Harness packages ship
 * in lockstep, so the presence of `ToolCallId` doubles as the generation probe.
 */
import type { Context } from '@deepseek-ai/cordis'
import * as llm from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

/** One content block as presented by a tool result, across both generations. */
export interface PatrolToolContentBlock {
  readonly type: string
  readonly text?: string
}

/** Canonical result of one tool call, as the 0.1.x single-call contract returned it. */
export type PatrolToolResult =
  | {
    readonly isError: false
    readonly value: unknown
    readonly content: readonly PatrolToolContentBlock[]
    readonly error?: undefined
  }
  | {
    readonly isError: true
    readonly error: { readonly message: string }
    readonly content: readonly PatrolToolContentBlock[]
    readonly value?: undefined
  }

export interface SingleToolCall {
  callId: string
  name: string
  arguments: unknown
  signal: AbortSignal
  agent?: ToolRunContext['agent']
  rootCallId?: ToolRunContext['rootCallId']
  parent?: ToolRunContext['token']
}

/** Harness 0.2.x exposes `ToolCallId`; 0.1.x exposes `CallId`. */
const brands = llm as unknown as {
  CallId?: (id: string) => string
  ToolCallId?: (id: string) => string
}

const brandCallId = brands.ToolCallId ?? brands.CallId

/** Whether the mounted Harness uses the 0.2.x batch tool-execution contract. */
export const batchToolExecution = brands.ToolCallId !== undefined

/** Brand a synthesized call id with whichever brand the mounted Harness exports. */
export function patrolCallId(id: string): string {
  return brandCallId === undefined ? id : brandCallId(id)
}

/** Minimal view of the tool service that both contracts satisfy once inputs are opaque. */
interface LooseToolService {
  execute(input: unknown): Promise<unknown>
}

interface BatchOutcome {
  readonly results?: readonly { readonly result?: PatrolToolResult }[]
}

/** Execute one tool call through whichever contract the mounted Harness offers. */
export async function executeSingleTool(ctx: Context, call: SingleToolCall): Promise<PatrolToolResult> {
  const tools = (ctx as unknown as { tools: LooseToolService }).tools
  const callId = patrolCallId(call.callId)

  if (!batchToolExecution) {
    const legacy = await tools.execute({
      callId,
      ...(call.rootCallId === undefined ? {} : { rootCallId: call.rootCallId }),
      name: call.name,
      arguments: call.arguments,
      signal: call.signal,
      ...(call.agent === undefined ? {} : { agent: call.agent }),
      ...(call.parent === undefined ? {} : { parent: call.parent }),
    })
    return legacy as PatrolToolResult
  }

  const batch = await tools.execute({
    calls: [{
      type: 'tool-call',
      id: callId,
      name: call.name,
      arguments: JSON.stringify(call.arguments),
    }],
    signal: call.signal,
    ...(call.agent === undefined ? {} : { agent: call.agent }),
  }) as BatchOutcome

  const outcome = batch.results?.[0]?.result
  if (outcome === undefined) {
    return {
      isError: true,
      error: { message: `${call.name} produced no result because the Harness did not settle it` },
      content: [],
    }
  }
  return outcome
}
