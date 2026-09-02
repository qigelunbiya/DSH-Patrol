// @ts-nocheck
import { Script } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { registerPatrolDashboardRoutes } from '../browser-bridge-runtime/dashboard-runtime.js'

describe('Patrol dashboard rendered client', () => {
  it('serves parseable browser JavaScript outside the HTML template', async () => {
    const routes = []
    const ctx = {
      webServer: {
        register(route) {
          routes.push(route)
          return () => {}
        },
      },
    }
    const dispose = registerPatrolDashboardRoutes(ctx, '/patrol-browser-bridge', { storagePath: '/tmp/dsh-patrol-dashboard-inline-script' })
    try {
      const ui = routes.find(route => route.path === '/patrol-browser-bridge/dashboard/ui')
      expect(ui).toBeDefined()

      const htmlResponse = response()
      await ui.handler({ method: 'GET', url: `${ui.path}?mode=flows&workspace=C%3A%5Cwork`, headers: {} }, htmlResponse)
      expect(htmlResponse.status).toBe(200)
      expect(htmlResponse.headers['content-security-policy']).toContain("script-src 'self'")
      expect(htmlResponse.body).toContain(`${ui.path}?asset=client`)
      expect(htmlResponse.body).not.toMatch(/<script>[^<]/)

      const clientResponse = response()
      await ui.handler({ method: 'GET', url: `${ui.path}?asset=client`, headers: {} }, clientResponse)
      expect(clientResponse.status).toBe(200)
      expect(clientResponse.headers['content-type']).toContain('text/javascript')
      expect(() => new Script(clientResponse.body, { filename: 'patrol-dashboard-client.js' })).not.toThrow()
    } finally {
      dispose()
    }
  })
})

function response() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers || {} },
    end(body = '') { this.body = String(body) },
  }
}
