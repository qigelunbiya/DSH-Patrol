import puppeteer from 'puppeteer-core'

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on', 'visible', 'foreground'])

export function patrolBrowserVisible(env = process.env) {
  return TRUE_VALUES.has(String(env.DSH_PATROL_BROWSER_VISIBLE || '').trim().toLowerCase())
}

export function patrolBrowserLaunchArgs({ extensionPath, legacyExtensionLoad = false, visible = patrolBrowserVisible() } = {}) {
  const args = [
    '--no-first-run',
    '--no-default-browser-check',
  ]

  if (visible) {
    args.push('--start-maximized')
  } else {
    // Keep the managed browser headful so unpacked-extension APIs, private
    // enterprise sites and occasional manual checkpoints retain compatibility,
    // but place its dedicated window outside the user's desktop by default.
    // Chromium keeps rendering while occluded/off-screen so screenshots and
    // DOM automation remain usable without repeatedly stealing foreground focus.
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
