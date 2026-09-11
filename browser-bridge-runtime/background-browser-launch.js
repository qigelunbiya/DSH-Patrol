import puppeteer from 'puppeteer-core'

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on', 'visible', 'foreground'])
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off', 'hidden', 'background'])

export function patrolBrowserVisible(env = process.env) {
  const explicit = String(env.DSH_PATROL_BROWSER_VISIBLE ?? '').trim().toLowerCase()
  if (TRUE_VALUES.has(explicit)) return true
  if (FALSE_VALUES.has(explicit)) return false

  // A managed Patrol browser is an interactive inspection surface: users need
  // to see that it is still alive, especially when a site presents a private
  // certificate page, a manual checkpoint, an external-protocol prompt, or a
  // slow enterprise splash screen. Hiding the window off-screen by default made
  // a healthy browser look as if it had closed. Background mode is therefore
  // opt-in instead of the default.
  const background = String(env.DSH_PATROL_BROWSER_BACKGROUND ?? '').trim().toLowerCase()
  if (TRUE_VALUES.has(background)) return false
  return true
}

export function patrolBrowserLaunchArgs({ extensionPath, legacyExtensionLoad = false, visible = patrolBrowserVisible() } = {}) {
  const args = [
    '--no-first-run',
    '--no-default-browser-check',
  ]

  if (visible) {
    args.push('--start-maximized')
  } else {
    // Explicit background mode remains available for unattended schedules.
    // Chromium stays headful so unpacked extensions and enterprise/private
    // sites keep working, but its dedicated window is placed off-screen.
    args.push('--window-position=-32000,-32000')
    args.push('--window-size=1440,900')
    args.push('--disable-backgrounding-occluded-windows')
    args.push('--disable-renderer-backgrounding')
    args.push('--disable-background-timer-throttling')
  }

  if (legacyExtensionLoad) {
    args.push(`--disable-extensions-except=${extensionPath}`)
    args.push(`--load-extension=${extensionPath}`)
  }
  return args
}

export async function defaultPatrolLaunchBrowser({
  executablePath,
  profilePath,
  extensionPath,
  startTimeoutMs,
  legacyExtensionLoad = false,
}) {
  return await puppeteer.launch({
    browser: 'chrome',
    executablePath,
    pipe: true,
    headless: false,
    userDataDir: profilePath,
    enableExtensions: true,
    defaultViewport: null,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    timeout: startTimeoutMs,
    args: patrolBrowserLaunchArgs({ extensionPath, legacyExtensionLoad }),
  })
}
