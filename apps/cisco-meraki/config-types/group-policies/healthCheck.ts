import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildMerakiClient, listGroupPolicies, listOrganizations } from '../../lib/merakiApi'
import { extractGroupPolicySpecs, groupPolicyKey, type MerakiGroupPolicy } from './_shared'

/**
 * Health check for group policy configuration:
 *   1. Meraki Dashboard API reachability + API key validity (GET /organizations)
 *   2. Every declared (network, name) pair still exists as a live group policy
 * Score is the percentage of passed checks (0-100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildMerakiClient(ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'meraki_credential', passed: false, message: built.error }] }
  }
  const { client } = built

  const specs = extractGroupPolicySpecs(ctx.canvas).filter((s) => s.networkId && s.name)

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

  const liveByNetwork = new Map<string, MerakiGroupPolicy[] | null>()
  for (const spec of specs) {
    const started = Date.now()
    const label = `${spec.networkId}/${spec.name}`
    try {
      if (!liveByNetwork.has(spec.networkId)) {
        liveByNetwork.set(spec.networkId, await listGroupPolicies(client, spec.networkId))
      }
      const live = liveByNetwork.get(spec.networkId) ?? []
      const present = live.some((p) => p.name && groupPolicyKey(p.name) === groupPolicyKey(spec.name))
      checks.push({
        name: `policy:${label}`,
        passed: present,
        message: present ? `Group policy "${label}" is present.` : `Group policy "${label}" is missing.`,
        latencyMs: Date.now() - started,
      })
    } catch (error) {
      checks.push({
        name: `policy:${label}`,
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
