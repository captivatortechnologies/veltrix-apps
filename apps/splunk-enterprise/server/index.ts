// ========================================================================
// Splunk Enterprise App - Server Entry Module
//
// Registers Splunk-specific API routes as a Fastify plugin.
// These routes are prefixed with /api/apps/splunk-enterprise/
// and protected by app-level auth + permission middleware.
// ========================================================================

import type { FastifyInstance } from 'fastify'
import type { AppRouteContext } from '@veltrixsecops/app-sdk'

export default async function registerRoutes(
  fastify: FastifyInstance,
  ctx: AppRouteContext,
) {
  const { hasPermission, db } = ctx

  // --- Index Configuration Routes ---

  fastify.get('/indexes', {
    preHandler: [hasPermission('indexes', 'read')],
    handler: async (request, reply) => {
      const customerId = (request as any).user?.customerId
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })

      const configs = await db.splunkEnterpriseIndexesConfiguration.findMany({
        where: { customerId },
        include: { environments: { include: { tag: true } } },
        orderBy: { updatedAt: 'desc' },
      })
      reply.send(configs)
    },
  })

  fastify.get('/indexes/defaults', {
    preHandler: [hasPermission('indexes', 'read')],
    handler: async (request, reply) => {
      const customerId = (request as any).user?.customerId
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })

      const defaults = await db.splunkEnterpriseIndexesDefaultConfiguration.findMany({
        where: { customerId },
        include: { environments: { include: { tag: true } } },
      })
      reply.send(defaults)
    },
  })

  // --- Role Configuration Routes ---

  fastify.get('/roles', {
    preHandler: [hasPermission('roles', 'read')],
    handler: async (request, reply) => {
      const customerId = (request as any).user?.customerId
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })

      const configs = await db.splunkEnterpriseRolesConfiguration.findMany({
        where: { customerId },
        include: { environments: { include: { tag: true } } },
        orderBy: { updatedAt: 'desc' },
      })
      reply.send(configs)
    },
  })

  fastify.get('/roles/defaults', {
    preHandler: [hasPermission('roles', 'read')],
    handler: async (request, reply) => {
      const customerId = (request as any).user?.customerId
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })

      const defaults = await db.splunkEnterpriseRolesDefaultConfiguration.findMany({
        where: { customerId },
        include: { environments: { include: { tag: true } } },
      })
      reply.send(defaults)
    },
  })

  // --- BYOL Infrastructure Routes ---

  fastify.get('/byol', {
    preHandler: [hasPermission('byol', 'read')],
    handler: async (request, reply) => {
      const customerId = (request as any).user?.customerId
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })

      const infra = await db.byolInfrastructure.findMany({
        where: { customerId },
        include: {
          indexerRegions: true,
          searchHeadRegions: true,
          splunkUpgrade: { include: { currentVersion: true } },
        },
        orderBy: { updatedAt: 'desc' },
      })
      reply.send(infra)
    },
  })

  // --- Version Management Routes ---

  fastify.get('/versions', {
    preHandler: [hasPermission('versions', 'read')],
    handler: async (_request, reply) => {
      const versions = await db.splunkVersion.findMany({
        where: { isActive: true },
        orderBy: { releaseDate: 'desc' },
      })
      reply.send(versions)
    },
  })

  // --- App Settings Routes ---

  fastify.get('/settings', {
    preHandler: [hasPermission('indexes', 'read')],
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
