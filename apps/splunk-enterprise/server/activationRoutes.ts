// ========================================================================
// Activation routes — the one-time credential handoff (see lib/activation*).
//
// GET  /activation/:token   → validate a link; return the env info to display.
// POST /activation/:token   → set the admin password (relayed to Splunk), then
//                             consume the token. Veltrix never stores the pw.
//
// These run behind the platform's app-auth (the admin is signed into the Veltrix
// console when they click the link), and are additionally gated by the single-
// use TOKEN and a customer-scope check — the authenticated user's customer must
// match the token's. No app-permission preHandler: the token IS the capability.
// ========================================================================

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { AppRouteContext } from '@veltrixsecops/app-sdk'
import { hashToken, isTokenUsable, checkPasswordPolicy } from '../lib/activation'
import { findTokenByHash, consumeToken } from '../lib/db/activation'
import { resolveBootstrapConnection } from '../lib/activationFlow'
import { relayAdminPassword } from '../lib/splunkAdmin'

function customerOf(request: FastifyRequest): string | null {
  return (request as any).user?.customerId ?? null
}

export function registerActivationRoutes(fastify: FastifyInstance, ctx: AppRouteContext): void {
  const { db } = ctx

  // Validate a link and return what the reset page needs to render.
  fastify.get(
    '/activation/:token',
    async (request: FastifyRequest<{ Params: { token: string } }>, reply: FastifyReply) => {
      const row = await findTokenByHash(db, hashToken(request.params.token))
      // Same 404 for unknown / wrong-customer / used / expired — never leak which.
      if (!row || row.customer_id !== customerOf(request) || !isTokenUsable(row, Date.now())) {
        return reply.code(404).send({ error: 'This activation link is invalid or has expired.' })
      }
      return reply.send({
        environmentName: row.environment_name,
        adminUser: row.admin_user,
        expiresAt: row.expires_at,
      })
    },
  )

  // Set the admin password: validate token → policy → relay to Splunk → consume.
  fastify.post(
    '/activation/:token',
    async (
      request: FastifyRequest<{ Params: { token: string }; Body: { password?: string } }>,
      reply: FastifyReply,
    ) => {
      const row = await findTokenByHash(db, hashToken(request.params.token))
      if (!row || row.customer_id !== customerOf(request) || !isTokenUsable(row, Date.now())) {
        return reply.code(404).send({ error: 'This activation link is invalid or has expired.' })
      }

      const password = request.body?.password ?? ''
      const policy = checkPasswordPolicy(password)
      if (!policy.ok) {
        return reply.code(400).send({ error: policy.message })
      }

      const conn = await resolveBootstrapConnection(db, row.infrastructure_id)
      if (!conn) {
        // Seam not wired yet / bootstrap secret unavailable — do not consume the
        // token, so the admin can retry once it is reachable.
        return reply.code(503).send({
          error: 'Activation is temporarily unavailable for this environment. Please try again shortly.',
        })
      }

      try {
        await relayAdminPassword({
          managementUrl: conn.managementUrl,
          bootstrapUsername: conn.username,
          bootstrapPassword: conn.password,
          adminUser: row.admin_user,
          newPassword: password,
        })
      } catch (err) {
        request.log?.error?.({ err }, 'activation: relay to Splunk failed')
        return reply.code(502).send({ error: 'Could not set the password on the environment. Please try again.' })
      }

      // Consume last, and only after a successful relay — conditional on still
      // being pending so a double-submit cannot consume twice.
      await consumeToken(db, row.id)
      return reply.send({ ok: true })
    },
  )
}
