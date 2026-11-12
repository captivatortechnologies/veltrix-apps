import { registerReports } from '../lib/reports'
import { capabilityFor } from '../lib/capabilities'
// =============================================================================
// Microsoft Entra ID — Server Entry Module
//
// Registers Entra-specific API routes as a Fastify plugin, prefixed with
// /api/apps/microsoft-entra-id/ and protected by app-level auth + permission
// middleware. Read-only on the platform side: authoring happens in the
// Configuration Canvas, and every write to Entra goes through the pipeline
// handlers (Microsoft Graph API).
// =============================================================================

import type { FastifyInstance } from 'fastify'
import type { AppRouteContext } from '@veltrixsecops/app-sdk'

export default async function registerRoutes(
  fastify: FastifyInstance,
  ctx: AppRouteContext,
): Promise<void> {
  const { hasPermission, db, manifest } = ctx
  registerReports(fastify,ctx)

  // Select an existing app permission explicitly, rather than requiring every operator
  // to hold Conditional Access permission. The platform still performs the RBAC check.
  const authorizeResource = async (request: any, reply: any) => {
    const resource = request.query?.resource ?? 'conditional-access-policies'
    if (typeof resource !== 'string' || !manifest.permissions.app.some(p => p.resource === resource)) {
      return reply.status(400).send({ error: 'Unknown app resource' })
    }
    return hasPermission(resource, 'read')(request, reply)
  }


  const resourcePermission = {
    requiresAppPermission: {
      resource: 'conditional-access-policies', action: 'read',
      resourceFromQuery: {
        key: 'resource', allowed: manifest.permissions.app.filter(permission => permission.actions.includes('read')).map(permission => permission.resource),
      },
    },
  }

  // Metadata for the Overview page: what this app manages, from the manifest.
  fastify.get('/meta', {
    config: resourcePermission,
    preHandler: [authorizeResource],
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
          capability: capabilityFor(ct.id),
        })),
      })
    },
  })

  // The tenant's saved app settings (e.g. tenant_id, request_timeout_seconds).
  fastify.get('/settings', {
    config: resourcePermission,
    preHandler: [authorizeResource],
    handler: async (request, reply) => {
      const customerId = (request as any).user?.customerId
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })
      const installation = await db.appInstallation.findFirst({
        where: { app: { appId: ctx.appId }, customerId, enabled: true },
      })
      const saved = (installation?.settings || {}) as Record<string, unknown>
      const allowed = ['tenant_id', 'request_timeout_seconds', 'azure_cloud', 'readiness_features', 'readiness_targets', 'connection_tenants']
      reply.send({ settings: Object.fromEntries(allowed.filter(k => k in saved).map(k => [k, saved[k]])) })
    },
  })
}
