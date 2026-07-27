import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import {
  buildFmgClient,
  fmgErrorMessage,
  readFmgSettings,
  resolveFmgCredential,
} from '../../lib/fortimanager'
import { appControlUrl } from './deploy'

export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []
  const settings = readFmgSettings(ctx.settings)
  const cred = resolveFmgCredential(ctx.credential, settings)

  if (!cred) {
    checks.push({ name: 'credential', passed: false, message: 'No usable FortiManager credential / host configured' })
    return { healthy: false, score: 0, checks }
  }

  const client = buildFmgClient(cred, settings)
  const start = Date.now()
  const resp = await client.get(appControlUrl(settings.adom))
  const latencyMs = Date.now() - start
  await client.logout()
  const passed = resp.ok

  checks.push({
    name: 'fmg-application-list',
    passed,
    message: passed ? `Reached the FortiManager application control table on ADOM "${settings.adom}"` : `FortiManager error: ${fmgErrorMessage(resp)}`,
    latencyMs,
  })

  return { healthy: passed, score: passed ? 100 : 0, checks }
}
