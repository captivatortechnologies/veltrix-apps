import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import {
  buildSecOpsClient,
  readSecOpsSettings,
  resolveSecOpsCredential,
  secopsErrorMessage,
} from '../../lib/googlesecops'

export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []
  const settings = readSecOpsSettings(ctx.settings)
  const cred = resolveSecOpsCredential(ctx.credential, settings)

  if (!cred) {
    checks.push({ name: 'credential', passed: false, message: 'No usable Google SecOps credential / region / project / instance configured' })
    return { healthy: false, score: 0, checks }
  }

  const client = buildSecOpsClient(cred, settings)
  const start = Date.now()
  const resp = await client.request('GET', `${client.parent()}/forwarders?pageSize=1`)
  const latencyMs = Date.now() - start
  const passed = resp.ok

  checks.push({
    name: 'secops-forwarders',
    passed,
    message: passed ? 'Reached the Google SecOps forwarders endpoint' : `Google SecOps error: ${secopsErrorMessage(resp)}`,
    latencyMs,
  })

  return { healthy: passed, score: passed ? 100 : 0, checks }
}
