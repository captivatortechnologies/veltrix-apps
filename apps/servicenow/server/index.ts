// ========================================================================
// ServiceNow App — Server Entry Module
//
// Registers ServiceNow-specific API routes as a Fastify plugin, prefixed with
// /api/apps/servicenow/ and protected by app-level auth + permission
// middleware. Business-rule CONFIGURATION authoring happens in the
// Configuration Canvas, and every config write goes through the pipeline
// handlers (ServiceNow Table API). This v0.1.0 foundation exposes read-only
// /meta + /settings routes that back the Overview page — there is no app
// database (no BYOL).
// ========================================================================

import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AppRouteContext } from '@veltrixsecops/app-sdk'

function customerOf(request: FastifyRequest): string | null {
  return (request as any).user?.customerId ?? null
}

export default async function registerRoutes(fastify: FastifyInstance, ctx: AppRouteContext) {
  const { hasPermission, db, manifest } = ctx

  fastify.get('/meta', {
    preHandler: [hasPermission('business-rules', 'read')],
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
    preHandler: [hasPermission('business-rules', 'read')],
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
