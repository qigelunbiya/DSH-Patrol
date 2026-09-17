import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const edit = readFileSync(join(process.cwd(), 'src', 'edit-tools.ts'), 'utf8')
const lifecycle = readFileSync(join(process.cwd(), 'src', 'lifecycle-store.ts'), 'utf8')
const store = readFileSync(join(process.cwd(), 'src', 'store.ts'), 'utf8')

describe('formal patrol record purpose', () => {
  it('marks edit validation and teaching as internal diagnostics', () => {
    expect(edit).toContain("runner.run(definition, exec, { purpose: 'validation' })")
    expect(edit).toContain("runner.resume(definition, exec, { purpose: 'validation' })")
    expect(lifecycle).toContain("purpose: 'teaching'")
    expect(store).toContain("purpose: report.purpose ?? 'patrol'")
  })
})
