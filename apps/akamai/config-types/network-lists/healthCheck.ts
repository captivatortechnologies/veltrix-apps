import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildAkamaiClient, NETWORK_LISTS_PATH } from '../../lib/akamaiApi'

/**
 * Health for network-lists config = the Akamai Network Lists API answers to an
 * EdgeGrid-signed request. Read-only:
 *   GET /network-list/v2/network-lists?listType=IP&includeElements=false
 * A 2xx confirms the host resolves AND the EdgeGrid signature authenticates.
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
    const res = await client.request('GET', NETWORK_LISTS_PATH, { query: { listType: 'IP', includeElements: false } })
    const passed = res.ok
    checks.push({
      name: 'akamai_reachable',
      passed,
      message: passed
        ? `Akamai Network Lists API reachable (HTTP ${res.status}).`
        : `Akamai Network Lists API returned HTTP ${res.status}.`,
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
