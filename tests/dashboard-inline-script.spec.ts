// @ts-nocheck
import { Script } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { registerPatrolDashboardRoutes } from '../browser-bridge-runtime/dashboard-fast.js'

describe('Patrol dashboard rendered client', () => {
  it('emits browser JavaScript that parses after template rendering', async () => {
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
      const response = {
        status: 0,
        headers: {},
        body: '',
        writeHead(status, headers) { this.status = status; this.headers = headers || {} },
        end(body = '') { this.body = String(body) },
      }
      await ui.handler({ method: 'GET', url: ui.path, headers: {} }, response)
      expect(response.status).toBe(200)
      const scripts = [...response.body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1])
      expect(scripts.length).toBeGreaterThan(0)
      for (const script of scripts) {
        try {
          new Script(script, { filename: 'patrol-dashboard-inline.js' })
        } catch (error) {
          console.error(error instanceof Error ? error.stack : error)
          console.error(script.split('\n').map((line, index) => `${String(index + 1).padStart(3, ' ')} | ${line}`).join('\n'))
          throw error
        }
      }
    } finally {
      dispose()
    }
  })
})
