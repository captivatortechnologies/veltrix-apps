// ========================================================================
// Splunk Enterprise App - Server Entry Module
//
// Registers Splunk-specific API routes as a Fastify plugin.
// These routes are prefixed with /api/apps/splunk-enterprise/
// and protected by app-level auth + permission middleware.
// ========================================================================

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { AppRouteContext, AppEventPublisher } from '@veltrixsecops/app-sdk'
import * as store from '../lib/db'

// --- small body coercion/validation helpers -----------------------------

function customerOf(request: FastifyRequest): string | null {
  return (request as any).user?.customerId ?? null
}

function toInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

/**
 * Editable scalar fields for a BYOL infrastructure record, coerced from a
 * request body. Region associations (indexerRegions / searchHeadRegions) and
 * the splunkUpgrade relation are intentionally NOT written here.
 * TODO regions: manage indexer/search-head region relation rows in a later pass.
 */
function readByol(body: any): { data: Record<string, unknown>; error?: string } {
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (!name) return { data: {}, error: 'Name is required' }
  if (name.length > 120) return { data: {}, error: 'Name must be 120 characters or fewer' }

  const deploymentType = typeof body?.deploymentType === 'string' ? body.deploymentType.trim() : 'single'
  const environmentType = typeof body?.environmentType === 'string' ? body.environmentType.trim() : ''
  // Provider name (a platform cloud-provider name, or "Self-Hosted"); no default
  // — Kubernetes is no longer a hosting option.
  const hostingType = typeof body?.hosting_type === 'string' ? body.hosting_type.trim() : ''
  // Cloud region (only meaningful for a distributed cloud deployment).
  const region = typeof body?.region === 'string' ? body.region.trim() : ''

  const indexerCount = toInt(body?.indexerCount, 1)
  const searchHeadCount = toInt(body?.searchHeadCount, 1)
  if (indexerCount < 1) return { data: {}, error: 'indexerCount must be at least 1' }
  if (searchHeadCount < 1) return { data: {}, error: 'searchHeadCount must be at least 1' }

  // "Distributed" is the multi-node Splunk topology (single instance is the other).
  if (deploymentType === 'distributed') {
    if (indexerCount < 3) return { data: {}, error: 'Distributed deployments require at least 3 indexers' }
    if (searchHeadCount < 2) return { data: {}, error: 'Distributed deployments require at least 2 search heads' }
  }

  const data: Record<string, unknown> = {
    name,
    deploymentType,
    environmentType,
    hosting_type: hostingType,
    region,
    indexerCount,
    searchHeadCount,
  }
  // cloudProviderId is optional (String?); only set when explicitly provided.
  if (typeof body?.cloudProviderId === 'string' && body.cloudProviderId.trim()) {
    data.cloudProviderId = body.cloudProviderId.trim()
  }
  return { data }
}

/** Best-effort publish of a provisioning event; never fails the request. */
async function emit(events: AppEventPublisher, topic: string, payload: unknown): Promise<void> {
  try {
    await events.publish(topic, payload)
  } catch (err) {
    console.error(`[splunk-enterprise] publish ${topic} failed:`, err)
  }
}

export default async function registerRoutes(
  fastify: FastifyInstance,
  ctx: AppRouteContext,
) {
  const { hasPermission, db, events } = ctx

  // --- BYOL Infrastructure Routes ---

  fastify.get('/byol', {
    preHandler: [hasPermission('byol', 'read')],
    handler: async (request, reply) => {
      const customerId = customerOf(request)
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })

      const infra = await store.listByol(db, customerId)
      reply.send(infra)
    },
  })

  fastify.get('/byol/:id', {
    preHandler: [hasPermission('byol', 'read')],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const customerId = customerOf(request)
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })
      const { id } = request.params as { id: string }

      const infra = await store.getByol(db, id, customerId)
      if (!infra) return reply.status(404).send({ error: 'BYOL infrastructure not found' })
      reply.send(infra)
    },
  })

  fastify.post('/byol', {
    preHandler: [hasPermission('byol', 'write')],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const customerId = customerOf(request)
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })

      const { data, error } = readByol(request.body)
      if (error) return reply.status(400).send({ error })

      const created = await store.createByol(db, customerId, data as unknown as store.ByolInput)
      // The app owns provisioning: emit its own event for downstream workers.
      await emit(events, 'infrastructure.created', { infrastructure: created, customerId })
      reply.status(201).send(created)
    },
  })

  fastify.put('/byol/:id', {
    preHandler: [hasPermission('byol', 'write')],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const customerId = customerOf(request)
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })
      const { id } = request.params as { id: string }

      const { data, error } = readByol(request.body)
      if (error) return reply.status(400).send({ error })

      const existing = await store.getByol(db, id, customerId)
      if (!existing) return reply.status(404).send({ error: 'BYOL infrastructure not found' })

      const updated = await store.updateByol(db, id, data as unknown as store.ByolInput)
      reply.send(updated)
    },
  })

  fastify.delete('/byol/:id', {
    preHandler: [hasPermission('byol', 'delete')],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const customerId = customerOf(request)
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })
      const { id } = request.params as { id: string }

      const existing = await store.getByol(db, id, customerId)
      if (!existing) return reply.status(404).send({ error: 'BYOL infrastructure not found' })

      await store.deleteByol(db, id)
      await emit(events, 'infrastructure.deleted', { infrastructureId: id, customerId })
      reply.status(204).send()
    },
  })

  // Lifecycle transitions. No real cloud orchestration exists for BYOL in the
  // legacy platform, so these routes only record the DESIRED state on the
  // record (start/restart -> running, stop -> stopped). Real provisioning is
  // out of scope; the platform/UI reflect this status.
  const registerLifecycle = (action: 'start' | 'stop' | 'restart', nextStatus: string) =>
    fastify.post(`/byol/:id/${action}`, {
      preHandler: [hasPermission('byol', 'write')],
      handler: async (request: FastifyRequest, reply: FastifyReply) => {
        const customerId = customerOf(request)
        if (!customerId) return reply.status(401).send({ error: 'Authentication required' })
        const { id } = request.params as { id: string }

        const existing = await store.getByol(db, id, customerId)
        if (!existing) return reply.status(404).send({ error: 'BYOL infrastructure not found' })

        const updated = await store.setByolStatus(db, id, nextStatus)
        reply.send(updated)
      },
    })

  registerLifecycle('start', 'running')
  registerLifecycle('stop', 'stopped')
  registerLifecycle('restart', 'running')

  // --- Version Management Routes ---

  fastify.get('/versions', {
    preHandler: [hasPermission('versions', 'read')],
    handler: async (_request, reply) => {
      const versions = await store.listActiveVersions(db)
      reply.send(versions)
    },
  })

  // --- Upgrade Operations ---

  fastify.get('/upgrades', {
    preHandler: [hasPermission('byol', 'read')],
    handler: async (request, reply) => {
      const customerId = customerOf(request)
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })

      const operations = await store.listUpgradeOperations(db, customerId)
      reply.send(operations)
    },
  })

  fastify.post('/upgrades', {
    preHandler: [hasPermission('byol', 'write')],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const customerId = customerOf(request)
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })

      const body = request.body as any
      const infrastructureId = typeof body?.infrastructureId === 'string' ? body.infrastructureId : ''
      const fromVersionId = typeof body?.fromVersionId === 'string' ? body.fromVersionId : ''
      const toVersionId = typeof body?.toVersionId === 'string' ? body.toVersionId : ''
      if (!infrastructureId || !fromVersionId || !toVersionId) {
        return reply.status(400).send({ error: 'infrastructureId, fromVersionId and toVersionId are required' })
      }
      if (fromVersionId === toVersionId) {
        return reply.status(400).send({ error: 'Target version must differ from the current version' })
      }

      // Ownership: the infrastructure must belong to this customer.
      const infra = await store.getByol(db, infrastructureId, customerId)
      if (!infra) return reply.status(404).send({ error: 'BYOL infrastructure not found' })

      const created = await store.createUpgradeOperation(db, {
        infrastructureId,
        fromVersionId,
        toVersionId,
        scheduledFor: typeof body?.scheduledFor === 'string' && body.scheduledFor ? body.scheduledFor : null,
        maintenanceWindow:
          typeof body?.maintenanceWindow === 'string' && body.maintenanceWindow ? body.maintenanceWindow : null,
      })
      reply.status(201).send(created)
    },
  })

  fastify.post('/upgrades/:id/status', {
    preHandler: [hasPermission('byol', 'write')],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const customerId = customerOf(request)
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })
      const { id } = request.params as { id: string }

      const status = (request.body as any)?.status
      if (typeof status !== 'string' || !store.UPGRADE_STATUSES.includes(status)) {
        return reply.status(400).send({ error: `status must be one of ${store.UPGRADE_STATUSES.join(', ')}` })
      }

      const owned = await store.isUpgradeOperationOwned(db, id, customerId)
      if (!owned) return reply.status(404).send({ error: 'Upgrade operation not found' })

      await store.setUpgradeOperationStatus(db, id, status)
      reply.status(204).send()
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
