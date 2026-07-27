import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import {
  buildMimecastClient,
  mimecastErrorMessage,
  readMimecastSettings,
  resolveMimecastCredential,
} from '../../lib/mimecast'

const GET_ALL = '/api/policy/address-alteration/get-policy'

export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []
  const settings = readMimecastSettings(ctx.settings)
  const cred = resolveMimecastCredential(ctx.credential, settings)

  if (!cred) {
    checks.push({ name: 'credential', passed: false, message: 'No usable Mimecast credential configured' })
    return { healthy: false, score: 0, checks }
  }

  const client = buildMimecastClient(cred, settings)
  const start = Date.now()
  const resp = await client.request(GET_ALL, {})
  const latencyMs = Date.now() - start
  const passed = resp.ok

  checks.push({
    name: 'mimecast-address-alteration',
    passed,
    message: passed ? 'Reached the Mimecast address alteration policy endpoint' : `Mimecast error: ${mimecastErrorMessage(resp)}`,
    latencyMs,
  })

  return { healthy: passed, score: passed ? 100 : 0, checks }
}
