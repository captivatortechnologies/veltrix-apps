import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import {
  addressUrl,
  buildFmgClient,
  fmgErrorMessage,
  readFmgSettings,
  resolveFmgCredential,
} from '../../lib/fortimanager'

export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []
  const settings = readFmgSettings(ctx.settings)
  const cred = resolveFmgCredential(ctx.credential, settings)

  if (!cred) {
    checks.push({
      name: 'credential',
      passed: false,
      message: 'No usable FortiManager credential / host configured',
    })
    return { healthy: false, score: 0, checks }
  }

  const client = buildFmgClient(cred, settings)
  const start = Date.now()
  // A get on the ADOM address table confirms login + ADOM access in one call.
  const resp = await client.get(addressUrl(settings.adom))
  const latencyMs = Date.now() - start
  await client.logout()
  const passed = resp.ok

  checks.push({
    name: 'fmg-firewall-address',
    passed,
    message: passed
      ? `Reached the FortiManager address table on ADOM "${settings.adom}"`
      : `FortiManager error: ${fmgErrorMessage(resp)}`,
    latencyMs,
  })

  return { healthy: passed, score: passed ? 100 : 0, checks }
}
