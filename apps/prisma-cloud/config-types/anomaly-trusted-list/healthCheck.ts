import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import {
  buildPcClient,
  pcErrorMessage,
  readPcSettings,
  resolvePcCredential,
} from '../../lib/prismacloud'

const BASE = '/anomalies/trusted_list'

export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []
  const settings = readPcSettings(ctx.settings)
  const cred = resolvePcCredential(ctx.credential, settings)

  if (!cred) {
    checks.push({ name: 'credential', passed: false, message: 'No usable Prisma Cloud credential / API URL configured' })
    return { healthy: false, score: 0, checks }
  }

  const client = buildPcClient(cred, settings)
  const start = Date.now()
  const resp = await client.get(BASE)
  const latencyMs = Date.now() - start
  const passed = resp.ok

  checks.push({
    name: 'prisma-anomaly-trusted-list',
    passed,
    message: passed ? 'Reached the Prisma Cloud anomaly trusted list endpoint' : `Prisma Cloud error: ${pcErrorMessage(resp)}`,
    latencyMs,
  })

  return { healthy: passed, score: passed ? 100 : 0, checks }
}
