import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildMerakiClient, getL3FirewallRules, listOrganizations } from '../../lib/merakiApi'
import { extractL3FirewallRuleSpecs } from './_shared'

/**
 * Health check for L3 firewall rules configuration:
 *   1. Meraki Dashboard API reachability + API key validity (GET /organizations)
 *   2. Every declared network's ruleset is still readable (network exists and
 *      is an MX-capable / appliance network)
 * Score is the percentage of passed checks (0-100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildMerakiClient(ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'meraki_credential', passed: false, message: built.error }] }
  }
  const { client } = built

  const specs = extractL3FirewallRuleSpecs(ctx.canvas).filter((s) => s.networkId)

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
    // Unreachable/unauthenticated — per-network checks would only repeat the same failure.
    return { healthy: false, score: 0, checks }
  }

  for (const spec of specs) {
    const started = Date.now()
    try {
      await getL3FirewallRules(client, spec.networkId)
      checks.push({
        name: `network:${spec.networkId}`,
        passed: true,
        message: `Network "${spec.networkId}" firewall ruleset is readable.`,
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
