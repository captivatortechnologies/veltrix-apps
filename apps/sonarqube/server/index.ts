// ========================================================================
// SonarQube App — Server Entry Module
//
// Registers SonarQube-specific API routes as a Fastify plugin, prefixed with
// /api/apps/sonarqube/ and protected by app-level auth + permission middleware.
// Quality-gate / profile / webhook / permission-template CONFIGURATION authoring
// happens in the Configuration Canvas and every config write goes through the
// pipeline handlers (SonarQube Web API). This foundation exposes read-only /meta
// + /settings routes that back the Overview page. The app additionally OWNS BYOL
// stack provisioning: the /byol routes derive a resource plan from a stack's
// topology, persist it, and emit provisioning events for downstream workers — the
// declarative provisioning foundation ships in infra/spec.ts.
// ========================================================================

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { AppRouteContext, AppEventPublisher } from '@veltrixsecops/app-sdk'
import { buildByolResourcePlan, DEPLOYMENT_STEPS } from '../lib/byolTopology'
import { readByol } from '../lib/byolInput'
import { buildByolPlan } from '../lib/byolPlanDiff'
import { resolvePlanNetwork, reserveDeployNetwork, NetworkAllocationConflictError } from '../lib/byolNetwork'
import * as store from '../lib/db'
import { collectForDate } from '../lib/usage/collector'

// --- small request/coercion helpers --------------------------------------

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
  { key: 'done', title: 'Resources destroyed', detail: 'All resources for this stack have been removed.' },
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
    // node_tiers-native: counts + placement are read by key from the tiers array.
    tiers: infra.tiers,
    hostingType: infra.hosting_type,
    isCloud: Boolean(infra.cloudProviderId),
    region: infra.region,
    controlPlaneLayout: infra.controlPlaneLayout,
    heavyForwarderCount: infra.heavyForwarderCount,
  }
}

/** Best-effort publish of a provisioning event; never fails the request. */
async function emit(events: AppEventPublisher, topic: string, payload: unknown): Promise<void> {
  try {
    await events.publish(topic, payload)
  } catch (err) {
    console.error(`[sonarqube] publish ${topic} failed:`, err)
  }
}

export default async function registerRoutes(fastify: FastifyInstance, ctx: AppRouteContext) {
  const { hasPermission, db, events, manifest } = ctx

  fastify.get('/meta', {
    preHandler: [hasPermission('quality-gates', 'read')],
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
    preHandler: [hasPermission('quality-gates', 'read')],
    handler: async (request, reply) => {
      const customerId = customerOf(request)
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })
      const installation = await db.appInstallation.findFirst({
        where: { app: { appId: ctx.appId }, customerId, enabled: true },
      })
      reply.send({ settings: installation?.settings || {} })
    },
  })

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

  // Lifecycle transitions record the DESIRED state on the record (start/restart ->
  // running, stop -> stopped). Real cloud orchestration is owned by the
  // provisioning workers; these routes flip the status the console + usage meter
  // reflect.
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
  // stack's topology, persists it, opens a deployment run, flips the record to
  // `provisioning`, and emits an event for the (external) provisioning workers.

  // Dry-run the deployment plan: diff the DESIRED topology plan against the
  // CURRENTLY persisted resource rows and return the Terraform-style
  // add/change/destroy summary + tier-grouped lines, ENRICHED with the subnet the
  // network allocator would carve (a dry-run peek) and the canonical tenant/cost
  // tag set every resource will carry. Side-effect-free.
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

      // Atomically reserve the stack's subnet + derive the tenant/cost tags before
      // seeding, so both the persisted rows and the emitted event carry them. A
      // subnet collision (the peeked block was taken between Plan and Apply)
      // surfaces as a 409 so the modal re-plans; other allocator errors degrade to
      // a tag-only result (the modeled apply still proceeds).
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

      await emit(events, 'infrastructure.deploy.requested', {
        infrastructureId: id,
        infrastructure: updated,
        plan,
        customerId,
        // Deployment target for the worker's resolveProvider (hosted vs BYOC).
        networkMode: updated.networkMode,
        dnsMode: updated.dnsMode,
        cloudAccountConnectionId: updated.cloudAccountConnectionId,
        // The initiating admin — a downstream hook can email them the one-time
        // access link when the stack is ready.
        adminEmail: (request as any).user?.email ?? null,
        // Tenant/cost-allocation tags + the reserved subnet, derived at Apply time.
        tags: deployNet.tags,
        ...(deployNet.network ? { network: deployNet.network } : {}),
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

      // tofu destroy still renders the config (validation + data sources + provider),
      // so the destroy event must carry the SAME deploy config — plan, network mode,
      // account, tags — or the worker re-renders an empty shared stack and fails.
      const plan = buildByolResourcePlan(topologyInputFor(infra))
      const destroyNet = await resolvePlanNetwork(infra, customerId, ctx.appId, customerShortNameOf(request))

      const deployment = await store.createDeployment(db, id, 'destroy', DESTROY_STEPS, userOf(request))
      const updated = await store.setByolStatus(db, id, 'destroying')
      await emit(events, 'infrastructure.destroy.requested', {
        infrastructureId: id,
        infrastructure: updated,
        plan,
        customerId,
        networkMode: updated.networkMode,
        dnsMode: updated.dnsMode,
        cloudAccountConnectionId: updated.cloudAccountConnectionId,
        tags: destroyNet.tags,
        ...(destroyNet.network ? { network: destroyNet.network } : {}),
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
  // service token holding `usage:write`. Node-hours only — SonarQube has no simple
  // built-in ingest metric (see collector.ts).
  fastify.post('/byol/usage/collect', {
    preHandler: [hasPermission('usage', 'write')],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const date = parseCollectDate(request.query)
      const result = await collectForDate(db, date)
      reply.send(result)
    },
  })
}
