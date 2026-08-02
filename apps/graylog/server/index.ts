// ========================================================================
// Graylog App — Server Entry Module
//
// Registers Graylog-specific API routes as a Fastify plugin, prefixed with
// /api/apps/graylog/ and protected by app-level auth + permission middleware.
// Stream CONFIGURATION authoring happens in the Configuration Canvas and every
// config write goes through the pipeline handlers (Graylog REST API). This
// foundation exposes read-only /meta + /settings routes that back the Overview
// page. BYOL hosting for the Graylog stack (Elasticsearch/OpenSearch + MongoDB +
// Graylog server) is planned for a later wave and intentionally not present yet.
// ========================================================================

import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AppRouteContext } from '@veltrixsecops/app-sdk'

function customerOf(request: FastifyRequest): string | null {
  return (request as any).user?.customerId ?? null
}

export default async function registerRoutes(fastify: FastifyInstance, ctx: AppRouteContext) {
  const { hasPermission, db, manifest } = ctx

  fastify.get('/meta', {
    preHandler: [hasPermission('streams', 'read')],
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
    preHandler: [hasPermission('streams', 'read')],
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
