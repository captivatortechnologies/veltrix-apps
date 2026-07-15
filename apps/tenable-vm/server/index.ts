// ========================================================================
// Tenable VM App — Server Entry Module
//
// Registers Tenable-specific API routes as a Fastify plugin, prefixed with
// /api/apps/tenable-vm/ and protected by app-level auth + permission
// middleware.
//
// The app is intentionally read-only on the platform side: configuration
// authoring happens in the Configuration Canvas, and every write to the
// Tenable tenant goes through the pipeline handlers (Tenable VM REST API).
// ========================================================================

import type { FastifyInstance } from 'fastify'
import type { AppRouteContext } from '@veltrixsecops/app-sdk'

export default async function registerRoutes(fastify: FastifyInstance, ctx: AppRouteContext) {
  const { hasPermission, db, manifest } = ctx

  // App metadata (config types, targets) for the client pages.
  fastify.get('/meta', {
    preHandler: [hasPermission('scans', 'read')],
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

  // Installation settings (base URL, timeout) for the client pages.
  fastify.get('/settings', {
    preHandler: [hasPermission('scans', 'read')],
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
