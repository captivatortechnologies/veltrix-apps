import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, falconErrorMessage } from '../../lib/falcon'
import { findRuleGroup } from './deploy'
import { extractRuleGroupSpecs, parseRuleSpecs } from './validate'

/**
 * Health check for custom IOA rule group configuration:
 *   1. Falcon API reachability + credential validity (Custom IOA rules scope)
 *   2. Every declared rule group exists on the tenant with the declared
 *      enablement state and all declared rules present — a group that should be
 *      enabled but is not (or is missing rules) means attacks go undetected.
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

  // Check 1: API reachable and the client has the Custom IOA rules scope
  const reachable = await timedCheck('falcon_reachable', async () => {
    const res = await client.request('GET', '/ioarules/queries/rule-groups/v1', {
      query: { limit: 1 },
    })
    if (res.status === 401) throw new Error('Falcon API client rejected (401) — check the client secret')
    if (res.status === 403) {
      throw new Error('Falcon API client lacks the "Custom IOA rules: Read" scope (403)')
    }
    if (!res.ok) throw new Error(falconErrorMessage(res))
    return `Falcon API reachable at ${baseUrl}`
  })
  checks.push(reachable)

  // Check 2..n: each declared group exists with the declared enablement + rules
  if (reachable.passed) {
    const specs = extractRuleGroupSpecs(ctx.canvas).filter((s) => s.name)
    for (const spec of specs) {
      checks.push(
        await timedCheck(`rule-group:${spec.name}`, async () => {
          const live = await findRuleGroup(client, spec.name, spec.platform)
          if (!live) {
            throw new Error(`Rule group "${spec.name}" (${spec.platform}) does not exist in the tenant`)
          }
          if (live.enabled !== spec.enabled) {
            throw new Error(
              `Rule group "${spec.name}" is ${live.enabled ? 'enabled' : 'disabled'} but should be ${
                spec.enabled ? 'enabled' : 'disabled'
              }`,
            )
          }
          const { rules } = parseRuleSpecs(spec.rulesRaw)
          const liveNames = new Set((live.rules ?? []).map((r) => r.name))
          const missing = rules.filter((r) => !liveNames.has(r.name)).map((r) => r.name)
          if (missing.length > 0) {
            throw new Error(`Rule group "${spec.name}" is missing declared rule(s): ${missing.join(', ')}`)
          }
          return `Rule group "${spec.name}" is present, ${
            spec.enabled ? 'enabled' : 'disabled'
          } as declared, with all ${rules.length} declared rule(s)`
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
