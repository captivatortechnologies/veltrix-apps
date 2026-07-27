import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, falconErrorMessage } from '../../lib/falcon'
import { findOverride } from './deploy'
import { extractOverrideSpecs } from './validate'

/** Cloud Security rules query — used only to probe reachability + read scope. */
const RULES_QUERY = '/cloud-policies/queries/rules/v1'

/**
 * Health check for rule override configuration:
 *   1. Falcon API reachability + credential validity (Cloud Security scope)
 *   2. Every declared override is present for its rule id
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

  // Check 1: API reachable and the client has the Cloud Security read scope.
  // The rule-overrides collection has no queries endpoint, so the rules query
  // (same cloud-policies family) is used to probe reachability.
  const reachable = await timedCheck('falcon_reachable', async () => {
    const res = await client.request('GET', RULES_QUERY, { query: { limit: 1 } })
    if (res.status === 401) throw new Error('Falcon API client rejected (401) — check the client secret')
    if (res.status === 403) {
      throw new Error('Falcon API client lacks the "Cloud security rules: Read" scope (403)')
    }
    if (!res.ok) throw new Error(falconErrorMessage(res))
    return `Falcon API reachable at ${baseUrl}`
  })
  checks.push(reachable)

  // Check 2..n: each declared override is present for its rule id
  if (reachable.passed) {
    const specs = extractOverrideSpecs(ctx.canvas).filter((s) => s.ruleId)
    for (const spec of specs) {
      checks.push(
        await timedCheck(`rule-override:${spec.ruleId}`, async () => {
          const live = await findOverride(client, spec.ruleId, spec.crn)
          if (!live) {
            throw new Error(`Override for rule "${spec.ruleId}" is not present in the tenant`)
          }
          return `Override for rule "${spec.ruleId}" is present`
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
