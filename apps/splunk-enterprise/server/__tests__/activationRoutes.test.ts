import Fastify, { type RouteOptions } from 'fastify'
import { registerActivationRoutes } from '../activationRoutes'
import type { AppRouteContext } from '@veltrixsecops/app-sdk'

// The platform registrar denies by default any app route that declares neither
// `config.requiresAppPermission` nor `config.public`. The activation routes are
// authorized by the single-use token, so they must carry the explicit opt-out.

async function registeredRoutes(): Promise<RouteOptions[]> {
  const app = Fastify()
  const routes: RouteOptions[] = []
  app.addHook('onRoute', (route) => {
    routes.push(route)
  })
  registerActivationRoutes(app, { db: {} } as unknown as AppRouteContext)
  await app.ready()
  await app.close()
  return routes
}

describe('activation routes and the default-deny gate', () => {
  it('declares config.public on every /activation/:token method', async () => {
    const routes = await registeredRoutes()
    const activation = routes.filter((r) => r.url === '/activation/:token')
    const methods = activation.flatMap((r) => (Array.isArray(r.method) ? r.method : [r.method]))

    expect(methods).toContain('GET')
    expect(methods).toContain('POST')
    for (const route of activation) {
      expect((route.config as { public?: boolean } | undefined)?.public).toBe(true)
    }
  })

  it('does not widen access with a permission requirement the token already replaces', async () => {
    const routes = await registeredRoutes()
    for (const route of routes) {
      expect((route.config as { requiresAppPermission?: unknown } | undefined)?.requiresAppPermission).toBeUndefined()
    }
  })
})
