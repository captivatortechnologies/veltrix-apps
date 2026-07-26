// =============================================================================
// SailPoint Identity Security Cloud — Server Entry Module
//
// Registers SailPoint-specific API routes as a Fastify plugin, prefixed with
// /api/apps/sailpoint/ and protected by app-level auth + permission middleware.
// Read-only on the platform side: authoring happens in the Configuration
// Canvas, and every write to ISC goes through the pipeline handlers (ISC API).
// =============================================================================

import type { FastifyInstance } from 'fastify'
import type { AppRouteContext } from '@veltrixsecops/app-sdk'

export default async function registerRoutes(
  fastify: FastifyInstance,
  ctx: AppRouteContext,
): Promise<void> {
  const { hasPermission, db, manifest } = ctx

  // Metadata for the Overview page: what this app manages, from the manifest.
  fastify.get('/meta', {
    preHandler: [hasPermission('transforms', 'read')],
    handler: async (request, reply) => {
      const customerId = (request as any).user?.customerId
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

  // The tenant's saved app settings (e.g. tenant, request_timeout_seconds).
  fastify.get('/settings', {
    preHandler: [hasPermission('transforms', 'read')],
    handler: async (request, reply) => {
      const customerId = (request as any).user?.customerId
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })
      const installation = await db.appInstallation.findFirst({
        where: { app: { appId: ctx.appId }, customerId, enabled: true },
      })
      reply.send({ settings: installation?.settings || {} })
    },
  })
}
