import { isPrivateNetworkUrl } from './managed-browser.js'

export function certificateActionForUrl(value) {
  return isPrivateNetworkUrl(value) ? 'continue' : 'cancel'
}

export async function installPrivateCertificateErrorHandler(browser, logger = console) {
  const session = await createBrowserSecuritySession(browser)
  if (!session) return false

  await session.send('Security.setOverrideCertificateErrors', { override: true })

  const onCertificateError = event => {
    const eventId = event?.eventId
    if (!Number.isInteger(eventId)) return
    const url = String(event?.url ?? '')
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
    try { void session.detach?.() } catch {}
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
