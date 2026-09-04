import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  PATROL_RECOVERY_WORKER_PROMPT,
  PATROL_SHELL_PROMPT,
  PATROL_SHELL_TOOL_ALLOWLIST,
  PATROL_SHELL_TOOL_BUDGET,
  PATROL_TEACHING_WORKER_PROMPT,
  patrolAssemblyMode,
  rewritePatrolPromptAssembly,
  type PatrolPromptAssemblyLike,
} from '../src/lazy-capability.ts'

function agent(header: { origin?: 'subagent'; delegationDepth?: number }) {
  return {
    ctx: {} as Context,
    session: { header },
  }
}

function assembly(toolNames: string[]): PatrolPromptAssemblyLike {
  return {
    sections: [
      { name: 'huge-system', text: 'x'.repeat(40_000) },
      { name: 'huge-patrol', text: 'y'.repeat(20_000) },
    ],
    contexts: [{ name: 'workspace', text: 'z'.repeat(10_000) }],
    tools: toolNames.map(name => ({ name })),
    variables: {},
  }
}

describe('Patrol lazy capability policy', () => {
  it('keeps the ordinary Patrol shell at a hard eight-tool budget', () => {
    expect(PATROL_SHELL_TOOL_ALLOWLIST.length).toBeLessThanOrEqual(PATROL_SHELL_TOOL_BUDGET)
    expect(new Set(PATROL_SHELL_TOOL_ALLOWLIST).size).toBe(PATROL_SHELL_TOOL_ALLOWLIST.length)
    expect(PATROL_SHELL_TOOL_ALLOWLIST).toContain('patrol_teach')
    expect(PATROL_SHELL_TOOL_ALLOWLIST).toContain('patrol_recover')
    expect(PATROL_SHELL_TOOL_ALLOWLIST.some(name => name.startsWith('browser_'))).toBe(false)
    expect(PATROL_SHELL_TOOL_ALLOWLIST).not.toContain('patrol_observe')
  })

  it('replaces the inherited heavy prompt/context stack for a top-level Patrol chat', () => {
    const input = assembly([...PATROL_SHELL_TOOL_ALLOWLIST])
    const output = rewritePatrolPromptAssembly(input, agent({}))
    expect(patrolAssemblyMode(input, agent({}))).toBe('shell')
    expect(output.sections).toEqual([{ name: 'agent:dsh-patrol-shell', text: PATROL_SHELL_PROMPT }])
    expect(output.contexts).toEqual([])
    expect(output.tools).toBe(input.tools)
    expect(JSON.stringify(output.sections).length).toBeLessThan(4000)
  })

  it('gives teaching and recovery children separate compact prompts based on their filtered tool pack', () => {
    const child = agent({ origin: 'subagent', delegationDepth: 1 })
    const teaching = rewritePatrolPromptAssembly(assembly(['patrol_create_inspection', 'patrol_observe']), child)
    expect(teaching.sections).toEqual([{ name: 'agent:dsh-patrol-teaching', text: PATROL_TEACHING_WORKER_PROMPT }])
    expect(teaching.contexts).toEqual([])

    const recovery = rewritePatrolPromptAssembly(assembly(['patrol_last_failure', 'patrol_recovery_action', 'patrol_resume_flow']), child)
    expect(recovery.sections).toEqual([{ name: 'agent:dsh-patrol-recovery', text: PATROL_RECOVERY_WORKER_PROMPT }])
    expect(recovery.contexts).toEqual([])
  })
})
