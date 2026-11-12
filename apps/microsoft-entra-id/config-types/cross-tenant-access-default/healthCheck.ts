import { verifyManagedConfiguration } from '../../lib/verification'
import driftDetect from './driftDetect'
import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  readGraphSettings,
  resolveGraphCredential,
} from '../../lib/graph'

const PATH = '/policies/crossTenantAccessPolicy/default'

export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings, ctx.identity)

  if (!cred) {
    checks.push({
      name: 'credential',
      passed: false,
      message: 'No usable Entra credential / tenant configured',
    })
    return { healthy: false, score: 0, checks }
  }

  const client = buildGraphClient(cred, settings)
  const start = Date.now()
  const resp = await client.get(PATH)
  const latencyMs = Date.now() - start
  const passed = resp.ok

  checks.push({
    name: 'graph-cross-tenant-access-default',
    passed,
    message: passed
      ? 'Reached the Entra cross-tenant access default policy endpoint'
      : `Graph error: ${graphErrorMessage(resp)}`,
    latencyMs,
  })

  return verifyManagedConfiguration(ctx, checks, driftDetect, 'cross-tenant-access-default')
}
