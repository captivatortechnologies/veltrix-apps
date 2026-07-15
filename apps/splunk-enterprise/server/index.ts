// ========================================================================
// Splunk Enterprise App - Server Entry Module
//
// Registers Splunk-specific API routes as a Fastify plugin.
// These routes are prefixed with /api/apps/splunk-enterprise/
// and protected by app-level auth + permission middleware.
// ========================================================================

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { AppRouteContext, AppEventPublisher } from '@veltrixsecops/app-sdk'
import { buildByolResourcePlan, DEPLOYMENT_STEPS } from '@veltrixsecops/app-sdk'
import * as store from '../lib/db'
import { collectForDate } from '../lib/usage/collector'
import {
  packageKey,
  presignUpload,
  presignDownload,
  parseS3Uri,
  toS3Uri,
  packagesBucket,
  uploadsEnabled,
  deletePackage,
} from '../lib/s3'
import { readVersion } from '../lib/versionInput'

// --- small body coercion/validation helpers -----------------------------

function customerOf(request: FastifyRequest): string | null {
  return (request as any).user?.customerId ?? null
}

function userOf(request: FastifyRequest): string | null {
  return (request as any).user?.id ?? null
}

/** Ordered steps a destroy run advances through (mirror of the deploy steps). */
const DESTROY_STEPS: Array<{ key: string; title: string; detail: string }> = [
  { key: 'plan', title: 'Teardown planned', detail: 'Destroy requested; resources marked for decommission.' },
  { key: 'drain', title: 'Draining & decommissioning', detail: 'Stopping services and removing compute, storage and network.' },
  { key: 'done', title: 'Resources destroyed', detail: 'All resources for this environment have been removed.' },
]

/** Parse a usage window (defaults to the last 30 days). */
function parseUsageWindow(query: unknown): { from: Date; to: Date } {
  const q = (query ?? {}) as { from?: string; to?: string }
  const parse = (v: string | undefined, fallback: number): Date => {
    if (v) {
      const d = new Date(v)
      if (!Number.isNaN(d.getTime())) return d
    }
    return new Date(fallback)
  }
  return {
    from: parse(q.from, Date.now() - 30 * 24 * 60 * 60 * 1000),
    to: parse(q.to, Date.now()),
  }
}

/** Parse the collection date (defaults to yesterday). */
function parseCollectDate(query: unknown): Date {
  const q = (query ?? {}) as { date?: string }
  if (q.date) {
    const d = new Date(q.date)
    if (!Number.isNaN(d.getTime())) return d
  }
  return new Date(Date.now() - 24 * 60 * 60 * 1000)
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

  // --- BYOL end-to-end deployment (resource plan + run tracking) ---
  //
  // The app owns provisioning: `deploy` derives the full resource plan from the
  // infrastructure's topology, persists it, opens a deployment run, flips the
  // record to `provisioning`, and emits an event for the (external) provisioning
  // workers. Workers report progress back through the app's onEvent/onWebhook
  // hooks, which advance the persisted resource + step rows.

  fastify.post('/byol/:id/deploy', {
    preHandler: [hasPermission('byol', 'write')],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const customerId = customerOf(request)
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })
      const { id } = request.params as { id: string }

      const infra = await store.getByol(db, id, customerId)
      if (!infra) return reply.status(404).send({ error: 'BYOL infrastructure not found' })

      const plan = buildByolResourcePlan({
        deploymentType: infra.deploymentType,
        indexerCount: infra.indexerCount,
        searchHeadCount: infra.searchHeadCount,
        hostingType: infra.hosting_type,
        isCloud: Boolean(infra.cloudProviderId),
        region: infra.region,
        indexerRegions: infra.indexerRegions.map((r) => r.region),
        searchHeadRegions: infra.searchHeadRegions.map((r) => r.region),
      })

      const resources = await store.seedResources(db, id, customerId, plan)
      const deployment = await store.createDeployment(db, id, 'deploy', DEPLOYMENT_STEPS, userOf(request))
      const updated = await store.setByolStatus(db, id, 'provisioning')
      await emit(events, 'infrastructure.deploy.requested', {
        infrastructureId: id,
        infrastructure: updated,
        plan,
        customerId,
      })
      reply.status(202).send({ infrastructure: updated, deployment, resources })
    },
  })

  fastify.post('/byol/:id/destroy', {
    preHandler: [hasPermission('byol', 'write')],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const customerId = customerOf(request)
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })
      const { id } = request.params as { id: string }

      const infra = await store.getByol(db, id, customerId)
      if (!infra) return reply.status(404).send({ error: 'BYOL infrastructure not found' })

      const deployment = await store.createDeployment(db, id, 'destroy', DESTROY_STEPS, userOf(request))
      const updated = await store.setByolStatus(db, id, 'destroying')
      await emit(events, 'infrastructure.destroy.requested', {
        infrastructureId: id,
        infrastructure: updated,
        customerId,
      })
      reply.status(202).send({ infrastructure: updated, deployment })
    },
  })

  fastify.get('/byol/:id/resources', {
    preHandler: [hasPermission('byol', 'read')],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const customerId = customerOf(request)
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })
      const { id } = request.params as { id: string }

      const infra = await store.getByol(db, id, customerId)
      if (!infra) return reply.status(404).send({ error: 'BYOL infrastructure not found' })
      const resources = await store.listResources(db, id)
      reply.send(resources)
    },
  })

  fastify.get('/byol/:id/deployments', {
    preHandler: [hasPermission('byol', 'read')],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const customerId = customerOf(request)
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })
      const { id } = request.params as { id: string }

      const infra = await store.getByol(db, id, customerId)
      if (!infra) return reply.status(404).send({ error: 'BYOL infrastructure not found' })
      const deployments = await store.listDeployments(db, id)
      reply.send(deployments)
    },
  })

  // --- BYOL Usage / Metering (foundation for usage-based cloud billing) ---

  // Read metered usage (node_hours + ingest_gb) for the current tenant over a
  // window. Powers the tenant usage view and the platform billing reader.
  fastify.get('/byol/usage', {
    preHandler: [hasPermission('usage', 'read')],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const customerId = customerOf(request)
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })
      const { from, to } = parseUsageWindow(request.query)
      const [summary, rows] = await Promise.all([
        store.aggregateUsage(db, { customerId, from, to }),
        store.listUsage(db, { customerId, from, to }),
      ])
      reply.send({ from: from.toISOString(), to: to.toISOString(), summary, rows })
    },
  })

  // Run the daily usage collector for a date (defaults to yesterday). Idempotent
  // — safe to re-run. Intended to be driven by the platform's daily cron with a
  // service token holding `usage:write`. Node-hours only until the Splunk
  // license-manager ingest poller is wired (see collector.ts).
  fastify.post('/byol/usage/collect', {
    preHandler: [hasPermission('usage', 'write')],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const date = parseCollectDate(request.query)
      const result = await collectForDate(db, date)
      reply.send(result)
    },
  })

  // --- Version Management Routes (system catalog + per-tenant versions) ---

  fastify.get('/versions', {
    preHandler: [hasPermission('versions', 'read')],
    handler: async (request, reply) => {
      const customerId = customerOf(request)
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })
      const versions = await store.listActiveVersions(db, customerId)
      reply.send(versions)
    },
  })

  // Whether package uploads are available (S3 bucket configured). The client
  // hides the "upload package" option when this is false.
  fastify.get('/versions/uploads-enabled', {
    preHandler: [hasPermission('versions', 'read')],
    handler: async (_request, reply) => {
      reply.send({ enabled: uploadsEnabled() })
    },
  })

  fastify.post('/versions', {
    preHandler: [hasPermission('versions', 'write')],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const customerId = customerOf(request)
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })
      const { data, error } = readVersion(request.body)
      if (error) return reply.status(400).send({ error })
      try {
        const created = await store.createVersion(db, customerId, data)
        reply.status(201).send(created)
      } catch {
        return reply.status(409).send({ error: `Version "${data.version}" already exists` })
      }
    },
  })

  fastify.put('/versions/:id', {
    preHandler: [hasPermission('versions', 'write')],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const customerId = customerOf(request)
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })
      const { id } = request.params as { id: string }
      // Only the owning tenant may edit — system versions are never matched.
      const existing = await store.getOwnedVersion(db, id, customerId)
      if (!existing) return reply.status(404).send({ error: 'Version not found or not editable' })

      const { data, error } = readVersion(request.body)
      if (error) return reply.status(400).send({ error })

      // Preserve an existing uploaded-package reference unless the client is
      // explicitly setting a new http(s) URL.
      const existingS3 = parseS3Uri(existing.downloadUrl)
      if (existingS3 && !data.downloadUrl) data.downloadUrl = existing.downloadUrl

      try {
        const updated = await store.updateVersion(db, id, customerId, data)
        if (!updated) return reply.status(404).send({ error: 'Version not found or not editable' })
        reply.send(updated)
      } catch {
        return reply.status(409).send({ error: `Version "${data.version}" already exists` })
      }
    },
  })

  fastify.delete('/versions/:id', {
    preHandler: [hasPermission('versions', 'delete')],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const customerId = customerOf(request)
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })
      const { id } = request.params as { id: string }
      const existing = await store.getOwnedVersion(db, id, customerId)
      if (!existing) return reply.status(404).send({ error: 'Version not found or not deletable' })

      const s3ref = parseS3Uri(existing.downloadUrl)
      if (s3ref) await deletePackage(s3ref.bucket, s3ref.key)

      await store.deleteVersion(db, id, customerId)
      reply.status(204).send()
    },
  })

  // Mint a presigned PUT URL so the browser uploads the installer directly to
  // S3, and record the object reference on the (owned) version. The client then
  // PUTs the file to `uploadUrl` with the given Content-Type.
  fastify.post('/versions/:id/package-url', {
    preHandler: [hasPermission('versions', 'write')],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const customerId = customerOf(request)
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })
      const bucket = packagesBucket()
      if (!bucket) return reply.status(503).send({ error: 'Package uploads are not configured' })

      const { id } = request.params as { id: string }
      const existing = await store.getOwnedVersion(db, id, customerId)
      if (!existing) return reply.status(404).send({ error: 'Version not found or not editable' })

      const body = request.body as { filename?: unknown; contentType?: unknown }
      const filename = typeof body?.filename === 'string' ? body.filename.trim() : ''
      if (!filename) return reply.status(400).send({ error: 'filename is required' })
      const contentType =
        typeof body?.contentType === 'string' && body.contentType.trim()
          ? body.contentType.trim()
          : 'application/octet-stream'

      const key = packageKey(customerId, id, filename)
      const uploadUrl = await presignUpload(key, contentType)
      await store.setVersionDownloadUrl(db, id, customerId, toS3Uri(bucket, key))
      reply.send({ uploadUrl, key, contentType })
    },
  })

  // Resolve a readable version's installer to a fetchable URL: a fresh presigned
  // GET for uploaded packages, or the stored http(s) URL. System + owned only.
  fastify.get('/versions/:id/download-url', {
    preHandler: [hasPermission('versions', 'read')],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const customerId = customerOf(request)
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })
      const { id } = request.params as { id: string }
      const existing = await store.getReadableVersion(db, id, customerId)
      if (!existing) return reply.status(404).send({ error: 'Version not found' })
      if (!existing.downloadUrl) return reply.status(404).send({ error: 'No installer attached to this version' })

      const s3ref = parseS3Uri(existing.downloadUrl)
      const url = s3ref ? await presignDownload(s3ref.bucket, s3ref.key) : existing.downloadUrl
      reply.send({ url })
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
