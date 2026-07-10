import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildSoarUrl, buildAuthHeader } from '../../lib/soarApi'

/**
 * Health check for a SOAR connection profile.
 * Verifies the platform can reach the Splunk SOAR instance and authenticate
 * against the REST API (GET /rest/version returns the SOAR product version).
 * Fails closed when credential or connectivity is missing.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const { component, credential, connectivity } = ctx
  const checks: HealthCheckResult['checks'] = []

  if (!credential || !connectivity) {
    return {
      healthy: false,
      score: 0,
      checks: [{ name: 'connectivity', passed: false, message: 'Missing credential or connectivity' }],
    }
  }

  const baseUrl = buildSoarUrl(component, connectivity)
  const auth = buildAuthHeader(credential)

  // Check: SOAR REST API reachable and authenticating
  checks.push(await timedCheck('server_reachable', async () => {
    const res = await fetch(`${baseUrl}/rest/version`, {
      method: 'GET',
      headers: auth,
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`SOAR /rest/version returned ${res.status}`)
    return 'Splunk SOAR instance is reachable'
  }))

  const passedCount = checks.filter((c) => c.passed).length
  return { healthy: passedCount === checks.length, score: Math.round((passedCount / checks.length) * 100), checks }
}

async function timedCheck(name: string, fn: () => Promise<string>): Promise<HealthCheckResult['checks'][0]> {
  const start = Date.now()
  try {
    const message = await fn()
    return { name, passed: true, message, latencyMs: Date.now() - start }
  } catch (error) {
    return { name, passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start }
  }
}
