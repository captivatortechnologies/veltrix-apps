// ========================================================================
// Splunk Enterprise App - Server Entry Module
//
// Registers Splunk-specific API routes as a Fastify plugin.
// These routes are prefixed with /api/apps/splunk-enterprise/
// and protected by app-level auth + permission middleware.
// ========================================================================

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { AppRouteContext, AppEventPublisher } from '@veltrixsecops/app-sdk'
import { buildByolResourcePlan } from '../lib/byolTopology'
import { readByol } from '../lib/byolInput'
import { buildByolPlan } from '../lib/byolPlanDiff'
import { resolvePlanNetwork, deriveProviderCode } from '../lib/byolNetwork'
import * as store from '../lib/db'
import { requestOperation, deleteRecord, atomic, lockInfrastructure, assertIdle, lifecycleError } from '../lib/byolLifecycle'
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
import { readLicenseInput } from '../lib/licenseInput'
import { parseSplunkLicenseXml } from '../lib/licenseXml'
import { getLiveLicenseStatus } from '../lib/liveLicense'
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

      const updated = await atomic(db, async tx => {
        const row = await lockInfrastructure(tx, id, customerId)
        if (!row) throw lifecycleError('BYOL infrastructure not found', 404)
        assertIdle(row)
        // A live or partially applied stack retains its cloud identity until teardown.
        if (row.applied_configuration || !['not_started', 'deprovisioned'].includes(row.status)) {
          throw lifecycleError('Destroy infrastructure before editing its topology or deployment target.')
        }
        return store.updateByol(tx, id, data as unknown as store.ByolInput)
      })
      reply.send(updated)
    },
  })

  fastify.delete('/byol/:id', {
    preHandler: [hasPermission('byol', 'delete')],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const customerId = customerOf(request)
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })
      const { id } = request.params as { id: string }

      await deleteRecord(ctx, customerId, id)
      reply.status(204).send()
    },
  })

  // start/stop/restart used to flip the record's status without touching any
  // cloud resource. The record must never claim a state the cloud is not in, so
  // these answer 501 until a worker-backed implementation exists.
  for (const action of ['start', 'stop', 'restart'] as const) {
    fastify.post(`/byol/:id/${action}`, {
      preHandler: [hasPermission('byol', 'write')],
      handler: async (request: FastifyRequest, reply: FastifyReply) => {
        const customerId = customerOf(request)
        if (!customerId) return reply.status(401).send({ error: 'Authentication required' })
        const { id } = request.params as { id: string }

        const existing = await store.getByol(db, id, customerId)
        if (!existing) return reply.status(404).send({ error: 'BYOL infrastructure not found' })

        return reply.status(501).send({ error: 'This cloud lifecycle action is not implemented. Use Provision or Destroy; changing a record cannot start or stop cloud instances.' })
      },
    })
  }

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

  for (const action of ['deploy', 'destroy'] as const) {
    fastify.post(`/byol/:id/${action}`, {
      preHandler: [hasPermission('byol', 'write')],
      handler: async (request: FastifyRequest, reply: FastifyReply) => {
        const customerId = customerOf(request)
        if (!customerId) return reply.status(401).send({ error: 'Authentication required' })
        const { id } = request.params as { id: string }
        const result = await requestOperation(ctx, customerId, id, action, userOf(request), (request as any).user?.email)
        reply.status(202).send(result)
      },
    })
  }

  fastify.get('/byol/:id/readiness', {
    preHandler: [hasPermission('byol', 'read')],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const customerId = customerOf(request)
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })
      const infra = await store.getByol(db, (request.params as { id: string }).id, customerId)
      if (!infra) return reply.status(404).send({ error: 'BYOL infrastructure not found' })
      try {
        if (!ctx.provisioning) throw lifecycleError('Platform provisioning services are unavailable.', 503)
        if (['provisioning', 'destroying'].includes(infra.status)) throw lifecycleError('An operation is already in progress.')
        const provider = deriveProviderCode(infra)
        if (!provider || !infra.region) throw lifecycleError('Select a cloud provider and region.', 400)
        if (infra.networkMode === 'byoc' && !infra.cloudAccountConnectionId) throw lifecycleError('Select a verified cloud account for BYOC.', 400)
        await ctx.provisioning.assertAllowed({ provider, cloudAccountConnectionId: infra.cloudAccountConnectionId })
        reply.send({ allowed: true })
      } catch (error) {
        reply.send({ allowed: false, statusCode: (error as any).statusCode ?? 503, reason: (error as Error).message })
      }
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

  // --- License Management Routes ---
  //
  // Two data sources back the License page:
  //   1. Recorded license XML (always available) — the operator pastes/uploads a
  //      Splunk `.lic`; the server parses it (lib/licenseXml) and records the
  //      extracted fields (quota, expiration, features, ...) tenant-scoped.
  //   2. Live licenser status (best-effort) — when the tenant has a working
  //      Splunk Connection, /licenses/live pulls /services/licenser/licenses
  //      (+ pools) for real-time stack usage. It degrades to { available: false }
  //      when no connection exists or the instance is unreachable.

  fastify.get('/licenses', {
    preHandler: [hasPermission('licenses', 'read')],
    handler: async (request, reply) => {
      const customerId = customerOf(request)
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })
      const licenses = await store.listLicenses(db, customerId)
      reply.send(licenses)
    },
  })

  // Best-effort live licenser read over the tenant's Splunk Connection. The
  // client passes the chosen connection via `?credentialId=<id>`; the platform's
  // credential seam (ctx.resolveConnection) decrypts it server-side. Never errors
  // — returns { available: false, reason: 'no-connection' } when no credentialId
  // is supplied or none resolves, and { available: false, reason } when the
  // instance can't be reached.
  fastify.get('/licenses/live', {
    preHandler: [hasPermission('licenses', 'read')],
    handler: async (request, reply) => {
      const customerId = customerOf(request)
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })
      const rawCredentialId = (request.query as { credentialId?: unknown })?.credentialId
      const credentialId = typeof rawCredentialId === 'string' ? rawCredentialId.trim() : ''
      if (!credentialId) return reply.send({ available: false, reason: 'no-connection' })
      const result = await getLiveLicenseStatus(ctx.resolveConnection, customerId, credentialId)
      reply.send(result)
    },
  })

  fastify.post('/licenses', {
    preHandler: [hasPermission('licenses', 'write')],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const customerId = customerOf(request)
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })

      const { xml, error: inputError } = readLicenseInput(request.body)
      if (inputError || !xml) return reply.status(400).send({ error: inputError ?? 'License XML is required' })

      const { data, error } = parseSplunkLicenseXml(xml)
      if (error || !data) return reply.status(400).send({ error: error ?? 'Could not parse the license XML' })
      if (!data.guid) {
        return reply.status(400).send({ error: 'License XML has no <guid> — it does not look like a Splunk license' })
      }

      const recorded = await store.recordLicense(db, customerId, data, xml, userOf(request))
      reply.status(201).send(recorded)
    },
  })

  fastify.delete('/licenses/:id', {
    preHandler: [hasPermission('licenses', 'delete')],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const customerId = customerOf(request)
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })
      const { id } = request.params as { id: string }

      const existing = await store.getLicense(db, id, customerId)
      if (!existing) return reply.status(404).send({ error: 'License not found' })

      await store.deleteLicense(db, id, customerId)
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
