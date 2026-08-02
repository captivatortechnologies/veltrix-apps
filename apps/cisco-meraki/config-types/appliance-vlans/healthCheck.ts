import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildMerakiClient, getVlansEnabled, listOrganizations, listVlans } from '../../lib/merakiApi'
import { extractVlanSpecs } from './_shared'

/**
 * Health check for appliance VLAN configuration:
 *   1. Meraki Dashboard API reachability + API key validity (GET /organizations)
 *   2. VLANs are enabled on every declared network
 *   3. Every declared (network, id) pair still exists as a live VLAN
 * Score is the percentage of passed checks (0-100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildMerakiClient(ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'meraki_credential', passed: false, message: built.error }] }
  }
  const { client } = built

  const specs = extractVlanSpecs(ctx.canvas).filter((s) => s.networkId && s.id)

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

  const networksChecked = new Set<string>()
  const liveByNetwork = new Map<string, Awaited<ReturnType<typeof listVlans>> | null>()

  for (const spec of specs) {
    if (!networksChecked.has(spec.networkId)) {
      networksChecked.add(spec.networkId)
      const started = Date.now()
      try {
        const enabled = await getVlansEnabled(client, spec.networkId)
        checks.push({
          name: `vlans_enabled:${spec.networkId}`,
          passed: enabled,
          message: enabled
            ? `VLANs are enabled on network "${spec.networkId}".`
            : `VLANs are NOT enabled on network "${spec.networkId}" — deploys will fail until enabled in the dashboard.`,
          latencyMs: Date.now() - started,
        })
      } catch (error) {
        checks.push({
          name: `vlans_enabled:${spec.networkId}`,
          passed: false,
          message: error instanceof Error ? error.message : `Network "${spec.networkId}" is not reachable`,
          latencyMs: Date.now() - started,
        })
      }
    }

    const label = `${spec.networkId}/${spec.id}`
    const started = Date.now()
    try {
      if (!liveByNetwork.has(spec.networkId)) {
        liveByNetwork.set(spec.networkId, await listVlans(client, spec.networkId))
      }
      const live = liveByNetwork.get(spec.networkId) ?? []
      const present = live.some((v) => String(v.id ?? '').trim() === spec.id)
      checks.push({
        name: `vlan:${label}`,
        passed: present,
        message: present ? `VLAN "${label}" is present.` : `VLAN "${label}" is missing.`,
        latencyMs: Date.now() - started,
      })
    } catch (error) {
      checks.push({
        name: `vlan:${label}`,
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
