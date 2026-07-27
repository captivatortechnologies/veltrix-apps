import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, falconErrorMessage } from '../../lib/falcon'
import { getGroupByName, getRulesForGroup } from './deploy'
import { extractRuleGroupSpecs, parseRuleSpecs } from './validate'

/**
 * Health check for FileVantage rule group configuration:
 *   1. Falcon API reachability + credential validity (FileVantage read scope)
 *   2. Every declared rule group exists on the tenant with the declared type and
 *      all declared rules present (matched by path) — a group missing rules
 *      leaves those paths unmonitored.
 * Score is the percentage of passed checks (0-100).
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

  // Check 1: API reachable and the client has the FileVantage read scope
  const reachable = await timedCheck('falcon_reachable', async () => {
    const res = await client.request('GET', '/filevantage/queries/rule-groups/v1', {
      query: { limit: 1 },
    })
    if (res.status === 401) throw new Error('Falcon API client rejected (401) — check the client secret')
    if (res.status === 403) {
      throw new Error('Falcon API client lacks the "Falcon FileVantage: Read" scope (403)')
    }
    if (!res.ok) throw new Error(falconErrorMessage(res))
    return `Falcon API reachable at ${baseUrl}`
  })
  checks.push(reachable)

  // Check 2..n: each declared group exists with the declared type + rules
  if (reachable.passed) {
    const specs = extractRuleGroupSpecs(ctx.canvas).filter((s) => s.name)
    for (const spec of specs) {
      checks.push(
        await timedCheck(`rule-group:${spec.name}`, async () => {
          const live = await getGroupByName(client, spec.name)
          if (!live) {
            throw new Error(`Rule group "${spec.name}" (${spec.type}) does not exist in the tenant`)
          }
          if ((live.type ?? '').toLowerCase() !== spec.type.toLowerCase()) {
            throw new Error(
              `Rule group "${spec.name}" is type ${live.type ?? 'unknown'} but should be ${spec.type}`,
            )
          }
          const { rules } = parseRuleSpecs(spec.rulesRaw)
          const liveRules = await getRulesForGroup(client, live)
          const livePaths = new Set(
            liveRules
              .filter((r) => typeof r.path === 'string')
              .map((r) => (r.path as string).toLowerCase()),
          )
          const missing = rules.filter((r) => !livePaths.has(r.path.toLowerCase())).map((r) => r.path)
          if (missing.length > 0) {
            throw new Error(`Rule group "${spec.name}" is missing declared rule(s): ${missing.join(', ')}`)
          }
          return `Rule group "${spec.name}" is present as ${spec.type} with all ${rules.length} declared rule(s)`
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
