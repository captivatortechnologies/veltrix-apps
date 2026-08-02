// ========================================================================
// Greenbone App — Server Entry Module
//
// Registers Greenbone-specific API routes as a Fastify plugin, prefixed with
// /api/apps/greenbone/ and protected by app-level auth + permission middleware.
// Scan-target CONFIGURATION authoring happens in the Configuration Canvas and
// every config write goes through the pipeline handlers (GMP over TLS). This
// v0.1.0 foundation exposes read-only /meta + /settings routes that back the
// Overview page; the per-connection connectivity test lives in
// handlers/testConnection.ts. BYOL hosting for the Greenbone stack is planned
// for a later release (no database yet).
// ========================================================================

import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AppRouteContext } from '@veltrixsecops/app-sdk'

function customerOf(request: FastifyRequest): string | null {
  return (request as any).user?.customerId ?? null
}

export default async function registerRoutes(fastify: FastifyInstance, ctx: AppRouteContext) {
  const { hasPermission, db, manifest } = ctx

  fastify.get('/meta', {
    preHandler: [hasPermission('targets', 'read')],
    handler: async (request, reply) => {
      const customerId = customerOf(request)
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })
      reply.send({
        appId: ctx.appId,
        name: manifest.name,
        version: manifest.version,
        configurationTypes: manifest.pipeline.configurationTypes.map((ct) => ({
          id: ct.id,
          name: ct.name,
          description: ct.description,
          componentTypes: ct.targets.componentTypes,
        })),
      })
    },
  })

  fastify.get('/settings', {
    preHandler: [hasPermission('targets', 'read')],
    handler: async (request, reply) => {
      const customerId = customerOf(request)
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })
      const installation = await db.appInstallation.findFirst({
        where: { app: { appId: ctx.appId }, customerId, enabled: true },
      })
      reply.send({ settings: installation?.settings || {} })
    },
  })
}
