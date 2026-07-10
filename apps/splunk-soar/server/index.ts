// ========================================================================
// Splunk SOAR App - Server Entry Module
//
// Registers SOAR-specific API routes as a Fastify plugin.
// These routes are prefixed with /api/apps/splunk-soar/
// and protected by app-level auth + permission middleware.
//
// The app is intentionally read-only on the platform side: connection
// profiles are authored in the Configuration Canvas and verified through
// the pipeline handlers (SOAR REST API). These routes only surface app
// status and the per-customer installation settings to the client pages.
// ========================================================================

import type { FastifyInstance } from 'fastify'
import type { AppRouteContext } from '@veltrixsecops/app-sdk'

export default async function registerRoutes(
  fastify: FastifyInstance,
  ctx: AppRouteContext,
) {
  const { hasPermission, db } = ctx

  // --- App status (used by the Overview page to confirm reachability) ---

  fastify.get('/status', async (_request, _reply) => {
    return { status: 'ok', appId: ctx.appId }
  })

  // --- App Settings (per-customer installation settings) ---

  fastify.get('/settings', {
    preHandler: [hasPermission('connection', 'read')],
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
