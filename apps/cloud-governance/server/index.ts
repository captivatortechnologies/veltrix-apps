// =============================================================================
// Veltrix Cloud Governance — app routes (prefix /api/apps/cloud-governance).
//
// Policies, exceptions and schedules are written through the configuration
// pipeline; these routes read them and drive RUNS. A run is the only thing
// that reaches a customer cloud, and it does so through the platform runner.
// =============================================================================

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { AppRouteContext } from '@veltrixsecops/app-sdk'
import * as store from '../lib/db'
import { requestRun, cancelRun } from '../lib/runLifecycle'
import type { RunKind } from '../lib/runner/contract'

function customerOf(request: FastifyRequest): string | null {
  return (request as any).user?.customerId ?? null
}

function userOf(request: FastifyRequest): string | null {
  return (request as any).user?.id ?? null
}

function readRunRequest(body: unknown): { value: { componentId: string; kind: RunKind; enforcement?: 'ask' | 'auto' } | null; error: string | null } {
  const b = (body ?? {}) as Record<string, unknown>
  const componentId = typeof b.componentId === 'string' ? b.componentId.trim() : ''
  const kind = b.kind === 'enforce' ? 'enforce' : b.kind === 'preview' ? 'preview' : null
  if (!componentId) return { value: null, error: 'componentId is required' }
  if (!kind) return { value: null, error: 'kind must be "preview" or "enforce"' }
  const enforcement = b.enforcement === 'ask' || b.enforcement === 'auto' ? b.enforcement : undefined
  return { value: { componentId, kind, enforcement }, error: null }
}

export default async function registerRoutes(fastify: FastifyInstance, ctx: AppRouteContext) {
  const { hasPermission, db } = ctx

  const withTenant = (handler: (customerId: string, request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const customerId = customerOf(request)
      if (!customerId) return reply.status(401).send({ error: 'Authentication required' })
      return handler(customerId, request, reply)
    }

  fastify.get('/policies', {
    preHandler: [hasPermission('policies', 'read')],
    handler: withTenant(async (customerId, _request, reply) => {
      const policies = await store.listPolicies(db, customerId)
      const accounts = await Promise.all(policies.map((p) => store.listPolicyAccounts(db, customerId, p.id)))
      reply.send(policies.map((p, i) => ({ ...p, accounts: accounts[i] })))
    }),
  })

  fastify.get('/policies/:id', {
    preHandler: [hasPermission('policies', 'read')],
    handler: withTenant(async (customerId, request, reply) => {
      const { id } = request.params as { id: string }
      const policy = await store.getPolicy(db, customerId, id)
      if (!policy) return reply.status(404).send({ error: 'Policy not found' })
      const [accounts, runs] = await Promise.all([
        store.listPolicyAccounts(db, customerId, id),
        store.listRuns(db, customerId, { policyId: id, limit: 20 }),
      ])
      reply.send({ ...policy, accounts, runs })
    }),
  })

  fastify.post('/policies/:id/runs', {
    preHandler: [hasPermission('runs', 'write')],
    handler: withTenant(async (customerId, request, reply) => {
      const { id } = request.params as { id: string }
      const { value, error } = readRunRequest(request.body)
      if (!value) return reply.status(400).send({ error })
      const result = await requestRun(ctx, customerId, { policyId: id, ...value, requestedBy: userOf(request) })
      reply.status(202).send(result)
    }),
  })

  fastify.get('/runs', {
    preHandler: [hasPermission('runs', 'read')],
    handler: withTenant(async (customerId, request, reply) => {
      const q = (request.query ?? {}) as { policyId?: string; limit?: string }
      const limit = q.limit ? Number(q.limit) : undefined
      reply.send(await store.listRuns(db, customerId, { policyId: q.policyId, limit: Number.isFinite(limit) ? limit : undefined }))
    }),
  })

  fastify.get('/runs/:id', {
    preHandler: [hasPermission('runs', 'read')],
    handler: withTenant(async (customerId, request, reply) => {
      const { id } = request.params as { id: string }
      const run = await store.getRun(db, customerId, id)
      if (!run) return reply.status(404).send({ error: 'Run not found' })
      const [matches, actions, policy] = await Promise.all([
        store.listMatches(db, customerId, id),
        store.listActions(db, customerId, id),
        store.getPolicy(db, customerId, run.policyId),
      ])
      reply.send({ run, matches, actions, policy })
    }),
  })

  fastify.post('/runs/:id/cancel', {
    preHandler: [hasPermission('runs', 'write')],
    handler: withTenant(async (customerId, request, reply) => {
      const { id } = request.params as { id: string }
      reply.status(202).send(await cancelRun(ctx, customerId, id))
    }),
  })

  fastify.get('/exceptions', {
    preHandler: [hasPermission('exceptions', 'read')],
    handler: withTenant(async (customerId, request, reply) => {
      const q = (request.query ?? {}) as { policy?: string }
      reply.send(await store.listExceptions(db, customerId, q.policy))
    }),
  })

  fastify.get('/schedules', {
    preHandler: [hasPermission('schedules', 'read')],
    handler: withTenant(async (customerId, _request, reply) => {
      reply.send(await store.listSchedules(db, customerId))
    }),
  })
}
