import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import {
  buildQRadarClient,
  qradarErrorMessage,
  readQRadarSettings,
  resolveQRadarCredential,
} from '../../lib/qradar'

export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []
  const settings = readQRadarSettings(ctx.settings)
  const cred = resolveQRadarCredential(ctx.credential, settings)

  if (!cred) {
    checks.push({ name: 'credential', passed: false, message: 'No usable IBM QRadar credential / console host configured' })
    return { healthy: false, score: 0, checks }
  }

  const client = buildQRadarClient(cred, settings)
  const start = Date.now()
  const resp = await client.request('GET', '/reference_data/maps', { range: 'items=0-0' })
  const latencyMs = Date.now() - start
  const passed = resp.ok

  checks.push({
    name: 'qradar-reference-maps',
    passed,
    message: passed ? 'Reached the QRadar reference-map endpoint' : `QRadar error: ${qradarErrorMessage(resp)}`,
    latencyMs,
  })

  return { healthy: passed, score: passed ? 100 : 0, checks }
}
