import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { INFO_VQL } from '../../lib/velociraptorApi'
import { buildClient, vqlTimeoutMs } from './_shared'

/**
 * Health for server-monitoring = the Velociraptor server answers a VQL query over
 * the gRPC API with the configured api-client config. Read-only: `SELECT * FROM
 * info()`; any rows back count as reachable + authenticated.
 *
 * VERIFY against a live Velociraptor server: info() returns at least one row.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const { component, credential, connectivity, settings } = ctx
  const checks: HealthCheck[] = []

  if (!credential) {
    checks.push({ name: 'credential', passed: false, message: 'No credential attached to this connection.' })
    return { healthy: false, score: 0, checks }
  }

  const started = Date.now()
  let client
  try {
    client = await buildClient(component, credential, connectivity, settings)
  } catch (error) {
    checks.push({
      name: 'velociraptor_reachable',
      passed: false,
      message: `api-client config incomplete: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
    return { healthy: false, score: 0, checks }
  }

  try {
    const rows = await client.runVQL(INFO_VQL, { timeoutMs: vqlTimeoutMs(settings), maxRows: 1 })
    const passed = rows.length > 0
    checks.push({
      name: 'velociraptor_reachable',
      passed,
      message: passed ? 'Velociraptor reachable over gRPC (info() returned).' : 'Velociraptor connected but info() returned no rows.',
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'velociraptor_reachable',
      passed: false,
      message: `Velociraptor unreachable over gRPC: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  } finally {
    await client.close().catch(() => {})
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
