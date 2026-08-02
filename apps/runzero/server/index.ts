// ========================================================================
// runZero App — Server Entry Module
//
// Registers runZero-specific API routes as a Fastify plugin, prefixed with
// /api/apps/runzero/ and protected by app-level auth + permission middleware.
// Read-only on the platform side: Site authoring happens in the Configuration
// Canvas, and every write goes through the pipeline handlers (runZero console
// REST API). This foundation exposes /meta + /settings, which back the Overview
// page. No app database — runZero is a SaaS, so there is nothing to persist here.
// ========================================================================

import type { FastifyInstance } from 'fastify'
import type { AppRouteContext } from '@veltrixsecops/app-sdk'

export default async function registerRoutes(fastify: FastifyInstance, ctx: AppRouteContext) {
  const { hasPermission, db, manifest } = ctx

  fastify.get('/meta', {
    preHandler: [hasPermission('sites', 'read')],
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

  fastify.get('/settings', {
    preHandler: [hasPermission('sites', 'read')],
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
