import Fastify, { type RouteOptions } from 'fastify'
import registerRoutes from '../index'
import type { AppRouteContext } from '@veltrixsecops/app-sdk'

// Every route must either declare a permission requirement, carry an inline
// hasPermission guard, or opt out with `config.public`; the platform registrar
// denies anything else by default.

async function registeredRoutes(): Promise<RouteOptions[]> {
  const app = Fastify()
  const routes: RouteOptions[] = []
  app.addHook('onRoute', (route) => {
    routes.push(route)
  })
  const guard = async () => undefined
  await registerRoutes(app, {
    appId: 'splunk-soar',
    db: {},
    hasPermission: () => guard,
  } as unknown as AppRouteContext)
  await app.ready()
  await app.close()
  return routes
}

describe('splunk-soar routes and the default-deny gate', () => {
  it('opts the status probe out of the permission gate', async () => {
    const status = (await registeredRoutes()).filter((r) => r.url === '/status')
    expect(status.length).toBeGreaterThan(0)
    for (const route of status) {
      expect((route.config as { public?: boolean } | undefined)?.public).toBe(true)
    }
  })

  it('leaves every other route gated', async () => {
    const others = (await registeredRoutes()).filter((r) => r.url !== '/status')
    expect(others.length).toBeGreaterThan(0)
    for (const route of others) {
      const guarded = (route.config as { requiresAppPermission?: unknown } | undefined)?.requiresAppPermission
      const pre = route.preHandler ? (Array.isArray(route.preHandler) ? route.preHandler : [route.preHandler]) : []
      expect(Boolean(guarded) || pre.length > 0).toBe(true)
    }
  })
})
