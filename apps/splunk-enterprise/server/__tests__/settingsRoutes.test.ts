import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import type { AppRouteContext } from '@veltrixsecops/app-sdk'
import registerRoutes from '../index'

test('settings authorizes the declared apps permission and scopes the enabled installation to the request customer', async () => {
  const app = Fastify()
  const queries: unknown[] = []
  app.addHook('onRequest', async request => { (request as any).user = { customerId: 'customer-1' } })
  await registerRoutes(app, {
    appId: 'splunk-enterprise',
    hasPermission: (resource: string, action: string) => async () => {
      assert.equal(resource, 'apps'); assert.equal(action, 'read')
    },
    db: { appInstallation: { findFirst: async (query: unknown) => { queries.push(query); return { settings: { splunk_api_port: 9090 } } } } },
  } as unknown as AppRouteContext)
  try {
    const res = await app.inject({ method: 'GET', url: '/settings' })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { settings: { splunk_api_port: 9090 } })
    assert.deepEqual(queries, [{ where: { app: { appId: 'splunk-enterprise' }, customerId: 'customer-1', enabled: true } }])
  } finally { await app.close() }
})

test('settings cannot read an installation without a customer or the apps read grant', async () => {
  for (const authorized of [false, true]) {
    const app = Fastify()
    let reads = 0
    await registerRoutes(app, {
      appId: 'splunk-enterprise',
      hasPermission: () => async (_request: unknown, reply: any) => { if (!authorized) return reply.status(403).send({ error: 'Forbidden' }) },
      db: { appInstallation: { findFirst: async () => { reads++; return {} } } },
    } as unknown as AppRouteContext)
    try {
      const res = await app.inject({ method: 'GET', url: '/settings' })
      assert.equal(res.statusCode, authorized ? 401 : 403)
      assert.equal(reads, 0)
    } finally { await app.close() }
  }
})
