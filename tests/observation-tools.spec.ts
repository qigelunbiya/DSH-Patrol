import { describe, expect, it } from 'vitest'
import { classifyBootstrapObservation, isBootstrapUnobservableUrl } from '../src/observation-tools.js'

describe('bootstrap current-page observation', () => {
  it('recognizes an initial active tab whose URL is unavailable', () => {
    expect(classifyBootstrapObservation({
      tabs: [{ id: 7, active: true, title: '', url: '' }],
    })).toEqual({ kind: 'unobservable-tab' })
  })

  it('recognizes Chromium new-tab pages but not real application pages', () => {
    expect(isBootstrapUnobservableUrl('chrome://newtab/')).toBe(true)
    expect(isBootstrapUnobservableUrl('about:blank')).toBe(true)
    expect(isBootstrapUnobservableUrl('https://10.192.1.125/login')).toBe(false)
  })

  it('uses the requested tab instead of a different active page', () => {
    expect(classifyBootstrapObservation({
      tabs: [
        { id: 1, active: true, title: 'Real page', url: 'https://example.com' },
        { id: 2, active: false, title: '', url: '' },
      ],
    }, 2)).toEqual({ kind: 'unobservable-tab' })
  })

  it('marks an empty browser as a no-tab bootstrap state', () => {
    expect(classifyBootstrapObservation({ tabs: [] })).toEqual({ kind: 'no-tab' })
  })
})
