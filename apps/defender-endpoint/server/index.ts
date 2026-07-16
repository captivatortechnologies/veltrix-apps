// ========================================================================
// Microsoft Defender for Endpoint App — Server Entry Module
//
// Registers Defender-specific API routes as a Fastify plugin, prefixed with
// /api/apps/defender-endpoint/ and protected by app-level auth + permission
// middleware. Read-only on the platform side: authoring happens in the
// Configuration Canvas, and every write goes through the pipeline handlers
// (Defender /api/indicators + Microsoft Graph beta).
// ========================================================================

import type { FastifyInstance } from 'fastify'
import type { AppRouteContext } from '@veltrixsecops/app-sdk'

export default async function registerRoutes(fastify: FastifyInstance, ctx: AppRouteContext) {
  const { hasPermission, db, manifest } = ctx

  fastify.get('/meta', {
    preHandler: [hasPermission('mde-file-indicators', 'read')],
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
    preHandler: [hasPermission('mde-file-indicators', 'read')],
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
