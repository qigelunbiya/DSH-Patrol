import { describe, expect, it } from 'vitest'
import {
  patrolBrowserLaunchArgs,
  patrolBrowserVisible,
} from '../browser-bridge-runtime/background-browser-launch.js'

describe('managed Patrol background browser launch', () => {
  it('keeps the default headful browser off the user desktop without maximizing it', () => {
    expect(patrolBrowserVisible({})).toBe(false)
    const args = patrolBrowserLaunchArgs({ extensionPath: '/extension', visible: false })
    expect(args).toContain('--window-position=-32000,-32000')
    expect(args).toContain('--window-size=1440,900')
    expect(args).toContain('--disable-backgrounding-occluded-windows')
    expect(args).not.toContain('--start-maximized')
  })

  it('supports an explicit visible debug override', () => {
    expect(patrolBrowserVisible({ DSH_PATROL_BROWSER_VISIBLE: '1' })).toBe(true)
    const args = patrolBrowserLaunchArgs({ extensionPath: 'C:/extension', legacyExtensionLoad: true, visible: true })
    expect(args).toContain('--start-maximized')
    expect(args).not.toContain('--window-position=-32000,-32000')
    expect(args).toContain('--disable-extensions-except=C:/extension')
    expect(args).toContain('--load-extension=C:/extension')
  })
})
