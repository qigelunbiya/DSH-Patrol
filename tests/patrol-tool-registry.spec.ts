import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../', import.meta.url))

// These are the source modules whose register* functions are composed by
// src/index.ts into one Patrol agent scope. Legacy/experimental modules that
// are exported but not mounted (for example excel-tools-v2/v3/v4) are omitted
// deliberately: duplicate ToolRuntime names matter only inside the live
// composition.
const REGISTERED_TOOL_SOURCES = [
  'src/tools.ts',
  'src/creation-tools.ts',
  'src/flow-reference-tools.ts',
  'src/flow-tools.ts',
  'src/credential-tools.ts',
  'src/action-tools.ts',
  'src/click-target-tools.ts',
  'src/observation-tools.ts',
  'src/transient-input-tools.ts',
  'src/totp-tools.ts',
  'src/handoff-tools.ts',
  'src/edit-tools.ts',
  'src/recovery-tools.ts',
  'src/workspace-tools.ts',
  'src/excel-tools-v5.ts',
  'src/scheduler.ts',
  'src/model-route-recovery.ts',
  'src/index.ts',
] as const

const PATROL_TOOL_NAME = /\bname:\s*['"](patrol_[a-z0-9_]+)['"]/g

function registeredPatrolToolOwners(): Map<string, string[]> {
  const owners = new Map<string, string[]>()
  for (const source of REGISTERED_TOOL_SOURCES) {
    const text = readFileSync(join(root, source), 'utf8')
    for (const match of text.matchAll(PATROL_TOOL_NAME)) {
      const toolName = match[1]
      if (toolName === undefined) continue
      const current = owners.get(toolName) ?? []
      current.push(source)
      owners.set(toolName, current)
    }
  }
  return owners
}

describe('Patrol live tool registry', () => {
  it('has exactly one owner for every mounted patrol_* tool name', () => {
    const duplicates = [...registeredPatrolToolOwners()]
      .filter(([, sources]) => sources.length > 1)
      .map(([name, sources]) => `${name}: ${sources.join(', ')}`)
      .sort()

    expect(duplicates).toEqual([])
  })

  it('keeps the current relative patrol_move_step implementation in edit-tools only', () => {
    const owners = registeredPatrolToolOwners()
    expect(owners.get('patrol_move_step')).toEqual(['src/edit-tools.ts'])

    const editTools = readFileSync(join(root, 'src', 'edit-tools.ts'), 'utf8')
    expect(editTools).toContain('beforeStepId')
    expect(editTools).toContain('afterStepId')
  })
})
