import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Patrol context pressure hardening mount', () => {
  it('mounts the hardened local-Qwen guard in the main plugin apply path', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf8')
    expect(source).toContain("from './context-pressure-hardening.js'")
    expect(source).toContain('registerPatrolContextPressureGuard(ctx)')
    expect(source).toContain('hardened local-Qwen context pressure protection')
    expect(source.match(/registerPatrolContextPressureGuard\(ctx\)/g)).toHaveLength(1)
  })

  it('does not mount pressure/integrity a second time inside model route recovery', () => {
    const routeRecovery = readFileSync(join(process.cwd(), 'src', 'model-route-recovery.ts'), 'utf8')
    expect(routeRecovery).not.toContain("from './context-pressure-hardening.js'")
    expect(routeRecovery).not.toContain("from './patrol-integrity.js'")
    expect(routeRecovery).not.toContain('registerPatrolContextPressureGuard(ctx)')
    expect(routeRecovery).not.toContain('registerPatrolIntegrity(ctx)')
  })
})
