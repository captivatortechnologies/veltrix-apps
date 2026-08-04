import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, fetchVersion } from '../../lib/openctiApi'

/**
 * Health for roles config = OpenCTI answers on its GraphQL API with the
 * configured API token. Read-only: `about { version }` (falls back to
 * `me { id name }`). A returned version/identity proves reachability AND that the
 * token authenticates.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const checks: HealthCheck[] = []

  if (!credential) {
    checks.push({ name: 'credential', passed: false, message: 'No credential attached to this connection.' })
    return { healthy: false, score: 0, checks }
  }

  const base = buildOpenctiUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)
  const started = Date.now()
  try {
    const version = await fetchVersion(base, headers, 8000)
    const passed = version !== null
    checks.push({
      name: 'opencti_reachable',
      passed,
      message: passed ? `OpenCTI reachable (${version}).` : 'OpenCTI did not return version or identity.',
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'opencti_reachable',
      passed: false,
      message: `OpenCTI unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
