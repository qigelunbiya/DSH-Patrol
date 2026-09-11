import { describe, expect, it } from 'vitest'
import {
  isTransientPatrolLaunchError,
  patrolBrowserLaunchArgs,
  patrolBrowserVisible,
} from '../browser-bridge-runtime/background-browser-launch.js'

describe('managed Patrol background browser launch', () => {
  it('keeps the default headful browser visible so it cannot look like it closed', () => {
    expect(patrolBrowserVisible({})).toBe(true)
    const args = patrolBrowserLaunchArgs({ extensionPath: '/extension', visible: true })
    expect(args).toContain('--start-maximized')
    expect(args).not.toContain('--window-position=-32000,-32000')
  })

  it('supports explicit background mode for unattended schedules', () => {
    expect(patrolBrowserVisible({ DSH_PATROL_BROWSER_BACKGROUND: '1' })).toBe(false)
    expect(patrolBrowserVisible({ DSH_PATROL_BROWSER_VISIBLE: '0' })).toBe(false)
    const args = patrolBrowserLaunchArgs({ extensionPath: '/extension', visible: false })
    expect(args).toContain('--window-position=-32000,-32000')
    expect(args).toContain('--window-size=1440,900')
    expect(args).toContain('--disable-backgrounding-occluded-windows')
    expect(args).not.toContain('--start-maximized')
  })

  it('supports an explicit visible override and legacy extension loading', () => {
    expect(patrolBrowserVisible({ DSH_PATROL_BROWSER_VISIBLE: '1', DSH_PATROL_BROWSER_BACKGROUND: '1' })).toBe(true)
    const args = patrolBrowserLaunchArgs({ extensionPath: 'C:/extension', legacyExtensionLoad: true, visible: true })
    expect(args).toContain('--start-maximized')
    expect(args).not.toContain('--window-position=-32000,-32000')
    expect(args).toContain('--disable-extensions-except=C:/extension')
    expect(args).toContain('--load-extension=C:/extension')
  })

  it('recognizes only transient closing/profile-lock launch failures as retryable', () => {
    expect(isTransientPatrolLaunchError(new Error('Protocol error: Browser is closing.'))).toBe(true)
    expect(isTransientPatrolLaunchError(new Error('user data directory is already in use'))).toBe(true)
    expect(isTransientPatrolLaunchError(new Error('Failed to launch: profile is locked by another Chromium process'))).toBe(true)
    expect(isTransientPatrolLaunchError(new Error('No usable sandbox!'))).toBe(false)
  })
})
