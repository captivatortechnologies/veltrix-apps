import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildHackeroneClient } from '../../lib/hackeroneApi'

/**
 * Health for the Structured Scopes config = HackerOne answers on the API with the
 * configured Basic-auth credential. Read-only probe: GET /me/programs?page[size]=1.
 * A 2xx (or any response below 500) counts as reachable; 401 means the API
 * identifier / token pair is bad.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const { credential, settings } = ctx
  const checks: HealthCheck[] = []

  if (!credential) {
    checks.push({ name: 'credential', passed: false, message: 'No credential attached to this connection.' })
    return { healthy: false, score: 0, checks }
  }

  const built = buildHackeroneClient(credential, settings)
  if ('error' in built) {
    checks.push({ name: 'credential', passed: false, message: built.error })
    return { healthy: false, score: 0, checks }
  }
  const { client } = built

  const started = Date.now()
  try {
    const res = await client.health()
    const passed = res.status > 0 && res.status < 500
    checks.push({
      name: 'hackerone_reachable',
      passed,
      message: passed ? `HackerOne API reachable (HTTP ${res.status}).` : `HackerOne returned HTTP ${res.status}.`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'hackerone_reachable',
      passed: false,
      message: `HackerOne unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
