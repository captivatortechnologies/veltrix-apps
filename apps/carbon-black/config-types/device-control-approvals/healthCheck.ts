import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import {
  buildCbClient,
  cbErrorMessage,
  readCbSettings,
  resolveCbCredential,
} from '../../lib/carbonblack'

export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []
  const settings = readCbSettings(ctx.settings)
  const cred = resolveCbCredential(ctx.credential, settings)

  if (!cred) {
    checks.push({ name: 'credential', passed: false, message: 'No usable Carbon Black credential / base URL / org key configured' })
    return { healthy: false, score: 0, checks }
  }

  const client = buildCbClient(cred, settings)
  const start = Date.now()
  const resp = await client.post(`${client.deviceControlPath('approvals')}/_search`, { criteria: {}, start: 0, rows: 1 })
  const latencyMs = Date.now() - start
  const passed = resp.ok

  checks.push({
    name: 'cbc-device-control-approvals',
    passed,
    message: passed ? 'Reached the Carbon Black device-control approvals endpoint' : `Carbon Black error: ${cbErrorMessage(resp)}`,
    latencyMs,
  })

  return { healthy: passed, score: passed ? 100 : 0, checks }
}
