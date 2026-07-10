// ========================================================================
// Splunk Enterprise App - Server Entry Module
//
// Registers Splunk-specific API routes as a Fastify plugin.
// These routes are prefixed with /api/apps/splunk-enterprise/
// and protected by app-level auth + permission middleware.
// ========================================================================

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { AppRouteContext } from '@veltrixsecops/app-sdk'

// --- small body coercion/validation helpers -----------------------------

function customerOf(request: FastifyRequest): string | null {
  return (request as any).user?.customerId ?? null
}

function toInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

function toBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim())
  if (typeof value === 'string')
    return value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
  return []
}

/** Fields for an index default configuration, coerced from a request body. */
function readIndexDefault(body: any): { data: Record<string, unknown>; error?: string } {
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (!name) return { data: {}, error: 'Name is required' }
  if (name.length > 120) return { data: {}, error: 'Name must be 120 characters or fewer' }
  const numeric: Array<[string, number]> = [
    ['maxEventSize', toInt(body?.maxEventSize, 10000)],
    ['retentionPeriod', toInt(body?.retentionPeriod, 30)],
    ['searchablePeriod', toInt(body?.searchablePeriod, 15)],
    ['frozenTimePeriod', toInt(body?.frozenTimePeriod, 90)],
  ]
  for (const [key, val] of numeric) {
    if (val < 0) return { data: {}, error: `${key} must not be negative` }
  }
  return {
    data: {
      name,
      maxEventSize: numeric[0][1],
      retentionPeriod: numeric[1][1],
      searchablePeriod: numeric[2][1],
      frozenTimePeriod: numeric[3][1],
      enableCompression: toBool(body?.enableCompression, true),
      enableTsidx: toBool(body?.enableTsidx, true),
      requireApproval: toBool(body?.requireApproval, true),
    },
  }
}

/** Fields for a role default configuration, coerced from a request body. */
function readRoleDefault(body: any): { data: Record<string, unknown>; error?: string } {
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (!name) return { data: {}, error: 'Name is required' }
  if (name.length > 120) return { data: {}, error: 'Name must be 120 characters or fewer' }
  return {
    data: {
      name,
      description: typeof body?.description === 'string' ? body.description.trim() || null : null,
      defaultPermissions: toStringArray(body?.defaultPermissions),
      requireApproval: toBool(body?.requireApproval, true),
    },
  }
}

export default async function registerRoutes(
  fastify: FastifyInstance,
  ctx: AppRouteContext,
) {
  const { hasPermission, db } = ctx

  // --- Index Configuration Routes ---

  fastify.get('/indexes', {
    preHandler: [hasPermission('indexes', 'read')],
    handler: async (request, reply) => {
      const customerId = customerOf(request)
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })

      const configs = await db.splunkEnterpriseIndexesConfiguration.findMany({
        where: { customerId },
        include: { environments: { include: { tag: true } } },
        orderBy: { updatedAt: 'desc' },
      })
      reply.send(configs)
    },
  })

  // --- Index Default Configuration Routes (app-managed templates) ---

  fastify.get('/indexes/defaults', {
    preHandler: [hasPermission('indexes', 'read')],
    handler: async (request, reply) => {
      const customerId = customerOf(request)
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })

      const defaults = await db.splunkEnterpriseIndexesDefaultConfiguration.findMany({
        where: { customerId },
        include: { environments: { include: { tag: true } } },
        orderBy: { updatedAt: 'desc' },
      })
      reply.send(defaults)
    },
  })

  fastify.post('/indexes/defaults', {
    preHandler: [hasPermission('indexes', 'write')],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const customerId = customerOf(request)
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })

      const { data, error } = readIndexDefault(request.body)
      if (error) return reply.status(400).send({ error })

      const created = await db.splunkEnterpriseIndexesDefaultConfiguration.create({
        data: { ...data, customerId },
      })
      reply.status(201).send(created)
    },
  })

  fastify.put('/indexes/defaults/:id', {
    preHandler: [hasPermission('indexes', 'write')],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const customerId = customerOf(request)
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })
      const { id } = request.params as { id: string }

      const { data, error } = readIndexDefault(request.body)
      if (error) return reply.status(400).send({ error })

      const existing = await db.splunkEnterpriseIndexesDefaultConfiguration.findFirst({
        where: { id, customerId },
      })
      if (!existing) return reply.status(404).send({ error: 'Index default configuration not found' })

      const updated = await db.splunkEnterpriseIndexesDefaultConfiguration.update({
        where: { id },
        data,
      })
      reply.send(updated)
    },
  })

  fastify.delete('/indexes/defaults/:id', {
    preHandler: [hasPermission('indexes', 'delete')],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const customerId = customerOf(request)
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })
      const { id } = request.params as { id: string }

      const existing = await db.splunkEnterpriseIndexesDefaultConfiguration.findFirst({
        where: { id, customerId },
      })
      if (!existing) return reply.status(404).send({ error: 'Index default configuration not found' })

      await db.splunkEnterpriseIndexesDefaultConfiguration.delete({ where: { id } })
      reply.status(204).send()
    },
  })

  // --- Role Configuration Routes ---

  fastify.get('/roles', {
    preHandler: [hasPermission('roles', 'read')],
    handler: async (request, reply) => {
      const customerId = customerOf(request)
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })

      const configs = await db.splunkEnterpriseRolesConfiguration.findMany({
        where: { customerId },
        include: { environments: { include: { tag: true } } },
        orderBy: { updatedAt: 'desc' },
      })
      reply.send(configs)
    },
  })

  // --- Role Default Configuration Routes (app-managed templates) ---

  fastify.get('/roles/defaults', {
    preHandler: [hasPermission('roles', 'read')],
    handler: async (request, reply) => {
      const customerId = customerOf(request)
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })

      const defaults = await db.splunkEnterpriseRolesDefaultConfiguration.findMany({
        where: { customerId },
        include: { environments: { include: { tag: true } } },
        orderBy: { updatedAt: 'desc' },
      })
      reply.send(defaults)
    },
  })

  fastify.post('/roles/defaults', {
    preHandler: [hasPermission('roles', 'write')],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const customerId = customerOf(request)
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })

      const { data, error } = readRoleDefault(request.body)
      if (error) return reply.status(400).send({ error })

      const created = await db.splunkEnterpriseRolesDefaultConfiguration.create({
        data: { ...data, customerId },
      })
      reply.status(201).send(created)
    },
  })

  fastify.put('/roles/defaults/:id', {
    preHandler: [hasPermission('roles', 'write')],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const customerId = customerOf(request)
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })
      const { id } = request.params as { id: string }

      const { data, error } = readRoleDefault(request.body)
      if (error) return reply.status(400).send({ error })

      const existing = await db.splunkEnterpriseRolesDefaultConfiguration.findFirst({
        where: { id, customerId },
      })
      if (!existing) return reply.status(404).send({ error: 'Role default configuration not found' })

      const updated = await db.splunkEnterpriseRolesDefaultConfiguration.update({
        where: { id },
        data,
      })
      reply.send(updated)
    },
  })

  fastify.delete('/roles/defaults/:id', {
    preHandler: [hasPermission('roles', 'delete')],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const customerId = customerOf(request)
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })
      const { id } = request.params as { id: string }

      const existing = await db.splunkEnterpriseRolesDefaultConfiguration.findFirst({
        where: { id, customerId },
      })
      if (!existing) return reply.status(404).send({ error: 'Role default configuration not found' })

      await db.splunkEnterpriseRolesDefaultConfiguration.delete({ where: { id } })
      reply.status(204).send()
    },
  })

  // --- BYOL Infrastructure Routes ---

  fastify.get('/byol', {
    preHandler: [hasPermission('byol', 'read')],
    handler: async (request, reply) => {
      const customerId = customerOf(request)
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
      const customerId = customerOf(request)
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })

      const installation = await db.appInstallation.findFirst({
        where: { app: { appId: ctx.appId }, customerId, enabled: true },
      })

      reply.send({ settings: installation?.settings || {} })
    },
  })
}
