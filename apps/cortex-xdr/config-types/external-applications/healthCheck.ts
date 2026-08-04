import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildCortexClient } from '../../lib/cortexXdrApi'

/**
 * Health for external applications config = Cortex XDR answers on its public API
 * with the configured API Key. Read-only: POST /endpoints/get_endpoint_groups/
 * with an empty request — the same tenant-reachability probe every config type
 * in this app uses (the `/platform/*` REST surface shares the tenant FQDN and
 * credential, so a passing probe here does not separately confirm `/platform/*`
 * reachability — VERIFY against a live tenant).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const { component, credential, settings } = ctx
  const checks: HealthCheck[] = []

  if (!credential) {
    checks.push({ name: 'credential', passed: false, message: 'No credential attached to this connection.' })
    return { healthy: false, score: 0, checks }
  }

  const built = buildCortexClient(component?.hostname, credential, settings)
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
      name: 'cortex_reachable',
      passed,
      message: passed
        ? `Cortex XDR reachable (HTTP ${res.status}).`
        : `Cortex XDR returned HTTP ${res.status}.`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'cortex_reachable',
      passed: false,
      message: `Cortex XDR unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
