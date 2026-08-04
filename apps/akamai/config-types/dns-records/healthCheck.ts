import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildAkamaiClient, DNS_ZONES_PATH } from '../../lib/akamaiApi'

/**
 * Health for dns-records config = the Edge DNS API answers to an EdgeGrid-
 * signed request. Read-only: GET /config-dns/v2/zones?pageSize=1 — a 2xx
 * confirms the host resolves AND the EdgeGrid signature authenticates for the
 * Edge DNS product (the same probe as dns-zones — recordsets share the zone
 * collection's reachability).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheck[] = []

  const built = buildAkamaiClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    checks.push({ name: 'credential', passed: false, message: built.error })
    return { healthy: false, score: 0, checks }
  }
  const { client } = built

  const started = Date.now()
  try {
    const res = await client.request('GET', DNS_ZONES_PATH, { query: { page: 1, pageSize: 1, showAll: false } })
    const passed = res.ok
    checks.push({
      name: 'akamai_reachable',
      passed,
      message: passed ? `Akamai Edge DNS API reachable (HTTP ${res.status}).` : `Akamai Edge DNS API returned HTTP ${res.status}.`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'akamai_reachable',
      passed: false,
      message: `Akamai API unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
