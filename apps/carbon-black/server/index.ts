// =============================================================================
// VMware Carbon Black Cloud — Server Entry Module
//
// Registers Carbon Black-specific API routes as a Fastify plugin, prefixed with
// /api/apps/carbon-black/ and protected by app-level auth + permission
// middleware. Read-only on the platform side: authoring happens in the
// Configuration Canvas, and every write to Carbon Black goes through the
// pipeline handlers (CBC API).
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
    preHandler: [hasPermission('reputation-overrides', 'read')],
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

  // The tenant's saved app settings (e.g. base_url, org_key).
  fastify.get('/settings', {
    preHandler: [hasPermission('reputation-overrides', 'read')],
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
