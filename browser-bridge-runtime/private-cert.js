import { isPrivateNetworkUrl } from './managed-browser.js'

export function certificateActionForUrl(value) {
  return isPrivateNetworkUrl(value) ? 'continue' : 'cancel'
}

export function certificateErrorRequestUrl(event) {
  // Chrome DevTools Protocol exposes the requested URL as `requestURL` on
  // Security.certificateError. Keep `url` only as a compatibility fallback for
  // older/fake clients. Using only event.url silently classified real Chrome
  // events as public/unknown and cancelled the private-network request.
  return String(event?.requestURL ?? event?.url ?? '')
}

export async function installPrivateCertificateErrorHandler(browser, logger = console) {
  const session = await createBrowserSecuritySession(browser)
  if (!session) return false

  // Security.enable is harmless on builds that support it and makes the
  // session's Security domain lifecycle explicit before enabling the override.
  try { await session.send('Security.enable') } catch {}
  await session.send('Security.setOverrideCertificateErrors', { override: true })

  const onCertificateError = event => {
    const eventId = event?.eventId
    if (!Number.isInteger(eventId)) return
    const url = certificateErrorRequestUrl(event)
    const action = certificateActionForUrl(url)
    void Promise.resolve(session.send('Security.handleCertificateError', { eventId, action }))
      .then(() => {
        if (action === 'continue') {
          logger.info?.(`[dsh-patrol/managed-browser] accepted private-network certificate error for ${url}`)
        } else {
          logger.warn?.(`[dsh-patrol/managed-browser] kept public certificate error blocked for ${url || '(unknown URL)'}`)
        }
      })
      .catch(error => logger.warn?.(`[dsh-patrol/managed-browser] certificate error decision failed: ${errorMessage(error)}`))
  }

  session.on?.('Security.certificateError', onCertificateError)
  browser.on?.('disconnected', () => {
    try { session.off?.('Security.certificateError', onCertificateError) } catch {}
    // Puppeteer may already detach this browser-level session before emitting
    // Browser.disconnected. detach() then returns a rejected Promise rather
    // than throwing synchronously. Swallow that expected shutdown race so
    // Ctrl+C / closing the managed browser never becomes a fatal load error.
    try {
      const detached = session.detach?.()
      if (detached && typeof detached.catch === 'function') {
        void detached.catch(error => {
          const message = errorMessage(error)
          if (!/already detached|session.*closed|target closed/i.test(message)) {
            logger.warn?.(`[dsh-patrol/managed-browser] CDP session detach failed during shutdown: ${message}`)
          }
        })
      }
    } catch (error) {
      const message = errorMessage(error)
      if (!/already detached|session.*closed|target closed/i.test(message)) {
        logger.warn?.(`[dsh-patrol/managed-browser] CDP session detach failed during shutdown: ${message}`)
      }
    }
  })
  return true
}

async function createBrowserSecuritySession(browser) {
  if (typeof browser?.createBrowserCDPSession === 'function') {
    return await browser.createBrowserCDPSession()
  }
  const target = typeof browser?.target === 'function' ? browser.target() : undefined
  if (typeof target?.createCDPSession === 'function') {
    return await target.createCDPSession()
  }
  return undefined
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
