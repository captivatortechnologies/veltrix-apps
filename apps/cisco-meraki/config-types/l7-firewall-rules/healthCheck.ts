import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildMerakiClient, getL7FirewallRules, listOrganizations } from '../../lib/merakiApi'
import { extractL7FirewallRuleSpecs } from './_shared'

/**
 * Health check for L7 firewall rules configuration:
 *   1. Meraki Dashboard API reachability + API key validity (GET /organizations)
 *   2. Every declared network's L7 ruleset is still readable
 * Score is the percentage of passed checks (0-100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildMerakiClient(ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'meraki_credential', passed: false, message: built.error }] }
  }
  const { client } = built

  const specs = extractL7FirewallRuleSpecs(ctx.canvas).filter((s) => s.networkId)

  const reachStarted = Date.now()
  try {
    await listOrganizations(client)
    checks.push({
      name: 'meraki_reachable',
      passed: true,
      message: 'Meraki Dashboard API reachable and API key accepted.',
      latencyMs: Date.now() - reachStarted,
    })
  } catch (error) {
    checks.push({
      name: 'meraki_reachable',
      passed: false,
      message: error instanceof Error ? error.message : 'Meraki Dashboard API unreachable',
      latencyMs: Date.now() - reachStarted,
    })
    return { healthy: false, score: 0, checks }
  }

  for (const spec of specs) {
    const started = Date.now()
    try {
      await getL7FirewallRules(client, spec.networkId)
      checks.push({
        name: `network:${spec.networkId}`,
        passed: true,
        message: `Network "${spec.networkId}" L7 ruleset is readable.`,
        latencyMs: Date.now() - started,
      })
    } catch (error) {
      checks.push({
        name: `network:${spec.networkId}`,
        passed: false,
        message: error instanceof Error ? error.message : `Network "${spec.networkId}" is not reachable`,
        latencyMs: Date.now() - started,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
