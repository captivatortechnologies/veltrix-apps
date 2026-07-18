// ========================================================================
// Splunk Enterprise App - Server Entry Module
//
// Registers Splunk-specific API routes as a Fastify plugin.
// These routes are prefixed with /api/apps/splunk-enterprise/
// and protected by app-level auth + permission middleware.
// ========================================================================

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { AppRouteContext, AppEventPublisher } from '@veltrixsecops/app-sdk'
import { buildByolResourcePlan, DEPLOYMENT_STEPS } from '../lib/byolTopology'
import { readByol } from '../lib/byolInput'
import { buildByolPlan } from '../lib/byolPlanDiff'
import { resolvePlanNetwork, reserveDeployNetwork, NetworkAllocationConflictError } from '../lib/byolNetwork'
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
import { registerActivationRoutes } from './activationRoutes'

// --- small body coercion/validation helpers -----------------------------

function customerOf(request: FastifyRequest): string | null {
  return (request as any).user?.customerId ?? null
}

/** The tenant's human-readable shortname (injected by the platform), or null. */
function customerShortNameOf(request: FastifyRequest): string | null {
  return (request as any).user?.customerShortName ?? null
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

/** Map a persisted infra to the topology builder's input (single source of truth). */
function topologyInputFor(infra: store.ByolDto) {
  return {
    deploymentType: infra.deploymentType,
    indexerCount: infra.indexerCount,
    searchHeadCount: infra.searchHeadCount,
    hostingType: infra.hosting_type,
    isCloud: Boolean(infra.cloudProviderId),
    region: infra.region,
    indexerRegions: infra.indexerRegions.map((r) => r.region),
    searchHeadRegions: infra.searchHeadRegions.map((r) => r.region),
    controlPlaneLayout: infra.controlPlaneLayout,
    heavyForwarderCount: infra.heavyForwarderCount,
    indexerPlacement: infra.indexerPlacement,
    searchHeadPlacement: infra.searchHeadPlacement,
  }
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

  // --- Activation (one-time credential handoff) routes ---
  registerActivationRoutes(fastify, ctx)

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

  // Dry-run the deployment plan: diff the DESIRED topology plan against the
  // CURRENTLY persisted resource rows and return the Terraform-style
  // add/change/destroy summary + tier-grouped lines, ENRICHED with the subnet
  // the network allocator would carve (a dry-run peek) and the canonical
  // tenant/cost tag set every resource will carry. Side-effect-free (no writes,
  // no emit, no CIDR commit) — the Plan modal fetches this before Apply calls
  // /deploy. If the allocator is unreachable the plan degrades gracefully
  // (tags only + a soft `networkUnavailable` flag) rather than failing.
  fastify.get('/byol/:id/plan', {
    preHandler: [hasPermission('byol', 'read')],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const customerId = customerOf(request)
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })
      const { id } = request.params as { id: string }

      const infra = await store.getByol(db, id, customerId)
      if (!infra) return reply.status(404).send({ error: 'BYOL infrastructure not found' })

      const desired = buildByolResourcePlan(topologyInputFor(infra))
      const current = await store.listResources(db, id)
      const diff = buildByolPlan(current, desired)
      const { network, tags, networkUnavailable } = await resolvePlanNetwork(
        infra,
        customerId,
        ctx.appId,
        customerShortNameOf(request),
      )

      reply.send({
        ...diff,
        tags,
        ...(network ? { network } : {}),
        ...(networkUnavailable ? { networkUnavailable: true } : {}),
      })
    },
  })

  fastify.post('/byol/:id/deploy', {
    preHandler: [hasPermission('byol', 'write')],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const customerId = customerOf(request)
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })
      const { id } = request.params as { id: string }

      const infra = await store.getByol(db, id, customerId)
      if (!infra) return reply.status(404).send({ error: 'BYOL infrastructure not found' })

      const plan = buildByolResourcePlan(topologyInputFor(infra))

      // Atomically reserve the stack's subnet + derive the tenant/cost tags
      // before seeding, so both the persisted rows and the emitted event carry
      // them. A subnet collision (the peeked block was taken between Plan and
      // Apply) surfaces as a 409 so the modal re-plans; other allocator errors
      // degrade to a tag-only result (the modeled apply still proceeds).
      let deployNet
      try {
        deployNet = await reserveDeployNetwork(infra, {
          customerId,
          appId: ctx.appId,
          infrastructureId: id,
          customerShortName: customerShortNameOf(request),
        })
      } catch (err) {
        if (err instanceof NetworkAllocationConflictError) {
          return reply.status(409).send({ error: 'Subnet allocation conflict — please re-plan and try again.' })
        }
        throw err
      }

      const resources = await store.seedResources(db, id, customerId, plan)
      // Stamp the allocated CIDR onto the foundation/network row so the console +
      // provisioning worker see the exact subnet this stack was given.
      if (deployNet.network) {
        await store.setResourceExternalRef(db, id, 'foundation/network', deployNet.network.subnetCidr)
      }
      const deployment = await store.createDeployment(db, id, 'deploy', DEPLOYMENT_STEPS, userOf(request))
      const updated = await store.setByolStatus(db, id, 'provisioning')

      // Resolve the selected Splunk version (system or tenant-owned catalog entry)
      // to its installer reference — an https:// URL or an s3://bucket/key URI
      // (an uploaded package). Omitted when no version is selected or the
      // resolved version has no download URL; the worker then uses its own
      // default installer/version.
      let splunkDownloadUrl: string | undefined
      if (updated.versionId) {
        const version = await store.getReadableVersion(db, updated.versionId, customerId)
        if (version?.downloadUrl) splunkDownloadUrl = version.downloadUrl
      }

      await emit(events, 'infrastructure.deploy.requested', {
        infrastructureId: id,
        infrastructure: updated,
        plan,
        customerId,
        // Deployment target for the worker's resolveProvider (hosted vs BYOC).
        networkMode: updated.networkMode,
        dnsMode: updated.dnsMode,
        cloudAccountConnectionId: updated.cloudAccountConnectionId,
        // The initiating admin — the activation hook emails them the one-time
        // link when the environment is ready (see hooks/onEvent + lib/activation).
        adminEmail: (request as any).user?.email ?? null,
        // Tenant/cost-allocation tags + the reserved subnet, derived at Apply time.
        tags: deployNet.tags,
        ...(deployNet.network ? { network: deployNet.network } : {}),
        ...(splunkDownloadUrl ? { splunkDownloadUrl } : {}),
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
