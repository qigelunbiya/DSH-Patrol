import { describe, expect, it } from 'vitest'
import { assertValidCron, cronMatches, normalizeCron } from '../src/scheduler.ts'

describe('Patrol scheduler cron', () => {
  it('normalizes and validates five-field cron expressions', () => {
    expect(normalizeCron('  0   9  * * 1-5 ')).toBe('0 9 * * 1-5')
    expect(() => assertValidCron('0 9 * * 1-5')).not.toThrow()
    expect(() => assertValidCron('0 9 * *')).toThrow(/5 fields/i)
    expect(() => assertValidCron('61 9 * * *')).toThrow(/between 0 and 59/i)
  })

  it('matches host-local schedule fields and weekday ranges', () => {
    const monday0900 = new Date(2026, 7, 31, 9, 0, 0)
    const monday0901 = new Date(2026, 7, 31, 9, 1, 0)
    expect(cronMatches('0 9 * * 1-5', monday0900)).toBe(true)
    expect(cronMatches('0 9 * * 1-5', monday0901)).toBe(false)
    expect(cronMatches('*/5 * * * *', new Date(2026, 7, 31, 9, 10, 0))).toBe(true)
  })

  it('uses standard day-of-month/day-of-week OR semantics', () => {
    const monday31 = new Date(2026, 7, 31, 12, 0, 0)
    expect(cronMatches('0 12 1 * 1', monday31)).toBe(true)
    expect(cronMatches('0 12 1 * 2', monday31)).toBe(false)
  })
})
