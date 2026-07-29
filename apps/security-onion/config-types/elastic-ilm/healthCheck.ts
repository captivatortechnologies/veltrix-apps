import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildEsUrl, buildAuthHeader, getJson } from '../../lib/soConsole'

/**
 * Health for ILM config = Elasticsearch is reachable with the configured
 * credential and the cluster is not red (an ILM PUT needs a writable cluster).
 * Read-only: GET ${esUrl}/_cluster/health.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const checks: HealthCheck[] = []

  if (!credential) {
    checks.push({ name: 'credential', passed: false, message: 'No credential attached to this connection.' })
    return { healthy: false, score: 0, checks }
  }

  const esUrl = buildEsUrl(component, connectivity, connectivityProvider)
  const auth = buildAuthHeader(credential)
  const started = Date.now()
  try {
    const health = await getJson<{ status?: string }>(`${esUrl}/_cluster/health`, auth, 8000)
    const status = String(health.status ?? '').toLowerCase()
    const passed = status === 'green' || status === 'yellow'
    checks.push({
      name: 'elasticsearch_reachable',
      passed,
      message: passed
        ? `Elasticsearch reachable — cluster status ${status}.`
        : `Elasticsearch cluster status is ${status || 'unknown'}.`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'elasticsearch_reachable',
      passed: false,
      message: `Elasticsearch unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
