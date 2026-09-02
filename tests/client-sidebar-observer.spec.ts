import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const client = readFileSync(resolve(import.meta.dirname, '..', 'client-host-runtime', 'client.js'), 'utf8')

describe('Patrol client sidebar observer', () => {
  it('does not reinsert the token entry when it is already in the correct position', () => {
    expect(client).toContain("entry.parentElement !== root || entry.previousElementSibling !== ssh")
    expect(client).toContain("button instanceof HTMLElement && (entry.parentElement !== root || entry.previousElementSibling !== button)")
  })

  it('does not rewrite the rail attribute unless its value actually changes', () => {
    expect(client).toContain("rail && !entry.hasAttribute('data-rail')")
    expect(client).toContain("!rail && entry.hasAttribute('data-rail')")
  })

  it('coalesces mutation callbacks instead of synchronously mutating on every observation', () => {
    expect(client).toContain('const schedulePlace = () => {')
    expect(client).toContain('queueMicrotask(place);')
    expect(client).toContain('new MutationObserver(schedulePlace)')
  })
})
