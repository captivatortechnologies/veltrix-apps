import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildBarracudaClient } from '../../lib/barracudaWaf'
import { extractHeaderRuleSpecs, headerRuleKey, listHeaderRules, type LiveHeaderRule } from './validate'

/**
 * Health check for Header Allow/Deny rules:
 *   1. Barracuda WAF-as-a-Service reachability + credential/Application validity
 *   2. Every declared rule still exists and its `enabled`/`active` flags match
 * Score is the percentage of passed checks (0-100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildBarracudaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'barracuda_credential', passed: false, message: built.error }] }
  }
  const { client, appName } = built

  const specs = extractHeaderRuleSpecs(ctx.canvas).filter((s) => s.name)
  const start = Date.now()
  let live: LiveHeaderRule[] | null = null

  try {
    live = await listHeaderRules(client, appName)
    checks.push({ name: 'barracuda_reachable', passed: true, message: `Barracuda WAF-as-a-Service reachable — Application "${appName}"`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({ name: 'barracuda_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (live) {
    const byKey = new Map(live.filter((r) => r.name).map((r) => [headerRuleKey(r.name as string), r]))
    for (const spec of specs) {
      const found = byKey.get(headerRuleKey(spec.name))
      if (!found) {
        checks.push({ name: `rule:${spec.name}`, passed: false, message: `Header Allow/Deny rule "${spec.name}" is missing` })
        continue
      }
      const matches = (found.enabled ?? true) === spec.enabled && (found.active ?? true) === spec.active
      checks.push({
        name: `rule:${spec.name}`,
        passed: matches,
        message: matches
          ? `Header Allow/Deny rule "${spec.name}" is present (enabled=${spec.enabled}, active=${spec.active})`
          : `Header Allow/Deny rule "${spec.name}" enabled/active state drifted`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passedCount / checks.length) * 100) : 0
  return { healthy: passedCount === checks.length, score, checks }
}
