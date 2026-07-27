import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import {
  buildDuoClient,
  duoErrorMessage,
  readDuoSettings,
  resolveDuoCredential,
} from '../../lib/duo'

const BASE = '/admin/v2/policies'

export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []
  const settings = readDuoSettings(ctx.settings)
  const cred = resolveDuoCredential(ctx.credential, settings)

  if (!cred) {
    checks.push({
      name: 'credential',
      passed: false,
      message: 'No usable Cisco Duo credential / API host configured',
    })
    return { healthy: false, score: 0, checks }
  }

  const client = buildDuoClient(cred, settings)
  const start = Date.now()
  const resp = await client.getV5(BASE, { limit: '1', offset: '0' })
  const latencyMs = Date.now() - start
  const passed = resp.ok

  checks.push({
    name: 'duo-admin-policies',
    passed,
    message: passed
      ? 'Reached the Duo Admin API policies endpoint'
      : `Duo error: ${duoErrorMessage(resp)} — note the Policies API requires a Duo Access/Essentials (or higher) edition; MFA-only accounts return an error here`,
    latencyMs,
  })

  return { healthy: passed, score: passed ? 100 : 0, checks }
}
