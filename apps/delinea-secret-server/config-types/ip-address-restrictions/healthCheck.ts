import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildSecretServerClient, secretServerErrorMessage } from '../../lib/secretServerApi'
import { extractIpRestrictionSpecs, listIpRestrictions, findIpRestrictionByName } from './_shared'

/**
 * Health for ip-address-restrictions config:
 *   1. Secret Server reachability + OAuth2 logon (GET /api/v1/ipaddress-restrictions?take=1)
 *   2. Every declared restriction (by name) still exists
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheck[] = []

  const built = buildSecretServerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'credential', passed: false, message: built.error }] }
  }
  const { client, apiBase } = built

  const started = Date.now()
  let reachable = false
  let allRestrictions: Awaited<ReturnType<typeof listIpRestrictions>> = []
  try {
    const res = await client.request('GET', '/ipaddress-restrictions', { query: { take: 1 } })
    reachable = res.ok
    checks.push({
      name: 'secretserver_reachable',
      passed: res.ok,
      message: res.ok ? `Secret Server reachable at ${apiBase}` : `Secret Server returned HTTP ${res.status}: ${secretServerErrorMessage(res)}`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'secretserver_reachable',
      passed: false,
      message: `Secret Server unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  if (reachable) {
    const specs = extractIpRestrictionSpecs(ctx.canvas.items ?? ctx.canvas.sections ?? []).filter((s) => s.name)
    try {
      allRestrictions = await listIpRestrictions(client)
    } catch (error) {
      checks.push({ name: 'ip_restrictions_list', passed: false, message: error instanceof Error ? error.message : 'list failed' })
    }
    for (const spec of specs) {
      const present = findIpRestrictionByName(allRestrictions, spec.name) !== null
      checks.push({
        name: `ip-address-restriction:${spec.name}`,
        passed: present,
        message: present ? `IP address restriction "${spec.name}" is present` : `IP address restriction "${spec.name}" is missing`,
      })
    }
  }

  const passed = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passed / checks.length) * 100) : 0
  return { healthy: passed === checks.length, score, checks }
}
