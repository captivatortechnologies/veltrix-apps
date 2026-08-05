import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildPingOneClient, parseJson, pingOneErrorMessage } from '../../lib/pingOne'
import { findPolicyByName, listActions } from './deploy'
import { actionPriority, extractPolicySpecs, parseActionsArray } from './validate'

/**
 * Health check for sign-on-policy configuration:
 *   1. PingOne environment reachability + worker credential validity
 *      (GET /environments/{environmentId} - a 401/403 means the worker
 *      Client ID/Secret were rejected or lack the needed role)
 *   2. Every declared policy (re-found by name) still exists
 *   3. Lightweight: every declared action's priority still exists on that
 *      policy (does not deep-diff the action body - see driftDetect for that)
 * Score is the percentage of passed checks (0-100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildPingOneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return {
      healthy: false,
      score: 0,
      checks: [{ name: 'pingone_credential', passed: false, message: built.error }],
    }
  }
  const { client, environmentId } = built

  // Check 1: environment reachable and the worker credential is accepted.
  const reachable = await timedCheck('pingone_reachable', async () => {
    const res = await client.request('GET', '')
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        'PingOne rejected the worker application credentials (check the Client ID/Secret and its role assignment)',
      )
    }
    if (!res.ok) throw new Error(pingOneErrorMessage(res))
    const env = parseJson<{ name?: string }>(res.body)
    return `PingOne environment ${environmentId} reachable${env?.name ? ` (${env.name})` : ''}`
  })
  checks.push(reachable)

  // Check 2..n: each declared policy still exists, and (lightly) its declared
  // actions are still present by priority.
  if (reachable.passed) {
    const specs = extractPolicySpecs(ctx.canvas).filter((s) => s.name)
    for (const spec of specs) {
      checks.push(
        await timedCheck(`policy:${spec.name}`, async () => {
          const live = await findPolicyByName(client, spec.name)
          if (!live?.id) throw new Error(`Sign-on policy "${spec.name}" does not exist in the environment`)

          if (spec.actionsJson) {
            const declared = parseActionsArray(spec.actionsJson) ?? []
            const liveActions = await listActions(client, live.id)
            const livePriorities = new Set(
              liveActions.map((a) => a.priority).filter((p): p is number => typeof p === 'number'),
            )
            const missing = declared
              .map((action) => actionPriority(action))
              .filter((p): p is number => p !== null && !livePriorities.has(p))
            if (missing.length > 0) {
              throw new Error(
                `Sign-on policy "${spec.name}" is missing action(s) at priority ${missing.join(', ')}`,
              )
            }
          }

          return `Sign-on policy "${spec.name}" is present${spec.actionsJson ? ' with its declared actions' : ''}`
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
