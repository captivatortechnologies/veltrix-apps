import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, falconErrorMessage } from '../../lib/falcon'
import { findEntityByIdentity } from '../../lib/entityAdapter'
import { RECON_RULE_ENDPOINTS, liveActionKey, listActionsForRule } from './deploy'
import { actionKey, extractReconRuleSpecs, parseActions } from './validate'

/**
 * Health check for Recon monitoring rule configuration:
 *   1. Falcon API reachability + credential validity (Recon monitoring scope)
 *   2. Every declared rule exists in the tenant with all its declared
 *      notification actions present — a missing rule or action means matches go
 *      unwatched or unnotified.
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return {
      healthy: false,
      score: 0,
      checks: [{ name: 'falcon_credential', passed: false, message: built.error }],
    }
  }
  const { client, baseUrl } = built

  // Check 1: API reachable and the client has the Recon monitoring rules scope
  const reachable = await timedCheck('falcon_reachable', async () => {
    const res = await client.request('GET', RECON_RULE_ENDPOINTS.queries, { query: { limit: 1 } })
    if (res.status === 401) throw new Error('Falcon API client rejected (401) — check the client secret')
    if (res.status === 403) {
      throw new Error('Falcon API client lacks the "Monitoring rules (Falcon Intelligence Recon): Read" scope (403)')
    }
    if (!res.ok) throw new Error(falconErrorMessage(res))
    return `Falcon API reachable at ${baseUrl}`
  })
  checks.push(reachable)

  // Check 2..n: each declared rule exists with all its declared actions
  if (reachable.passed) {
    const specs = extractReconRuleSpecs(ctx.canvas).filter((s) => s.name)
    for (const spec of specs) {
      checks.push(
        await timedCheck(`recon-rule:${spec.name}`, async () => {
          const live = await findEntityByIdentity(client, RECON_RULE_ENDPOINTS, spec.name)
          if (!live?.id) {
            throw new Error(`Recon monitoring rule "${spec.name}" does not exist in the tenant`)
          }
          const { actions } = parseActions(spec.actionsRaw)
          if (actions.length > 0) {
            const liveKeys = new Set((await listActionsForRule(client, live.id)).map(liveActionKey))
            const missing = actions.filter((a) => !liveKeys.has(actionKey(a)))
            if (missing.length > 0) {
              throw new Error(
                `Recon rule "${spec.name}" is missing ${missing.length} declared notification action(s)`,
              )
            }
          }
          return `Recon rule "${spec.name}" is present with all ${actions.length} declared action(s)`
        }),
      )
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)

  return {
    healthy: passedCount === checks.length,
    score,
    checks,
  }
}

async function timedCheck(
  name: string,
  fn: () => Promise<string>,
): Promise<HealthCheckResult['checks'][0]> {
  const start = Date.now()
  try {
    const message = await fn()
    return { name, passed: true, message, latencyMs: Date.now() - start }
  } catch (error) {
    return {
      name,
      passed: false,
      message: error instanceof Error ? error.message : 'Check failed',
      latencyMs: Date.now() - start,
    }
  }
}
