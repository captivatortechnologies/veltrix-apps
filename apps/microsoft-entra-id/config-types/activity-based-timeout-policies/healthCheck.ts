import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  readGraphSettings,
  resolveGraphCredential,
} from '../../lib/graph'

const BASE = '/policies/activityBasedTimeoutPolicies'

export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)

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
  const resp = await client.get(`${BASE}?$top=1&$select=id`)
  const latencyMs = Date.now() - start
  const passed = resp.ok

  checks.push({
    name: 'graph-activity-based-timeout-policies',
    passed,
    message: passed ? 'Reached the Entra activity based timeout policies endpoint' : `Graph error: ${graphErrorMessage(resp)}`,
    latencyMs,
  })

  return { healthy: passed, score: passed ? 100 : 0, checks }
}
