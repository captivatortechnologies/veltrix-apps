import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { ersBase, buildEndpointIdentityGroupsClient, readIseSettings, hasUsableCredential, MISSING_CREDENTIAL_MESSAGE } from '../../lib/iseApi'

/**
 * Health for this config type = ERS answers on the ISE PAN/admin node with the
 * configured credential. Read-only: GET /ers/config/endpointgroup?size=1 — the
 * same cheap reachability probe used by the connection test.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const checks: HealthCheck[] = []

  if (!hasUsableCredential(credential)) {
    checks.push({ name: 'credential', passed: false, message: MISSING_CREDENTIAL_MESSAGE })
    return { healthy: false, score: 0, checks }
  }

  const settings = readIseSettings(ctx.settings)
  const base = ersBase(component, connectivity, connectivityProvider)
  const client = buildEndpointIdentityGroupsClient(base, credential, settings)

  const started = Date.now()
  try {
    const { total } = await client.probe()
    checks.push({
      name: 'ers_reachable',
      passed: true,
      message: `ISE ERS reachable (${total} endpoint identity group(s) known).`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'ers_reachable',
      passed: false,
      message: `ISE ERS unreachable or rejected the request: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
