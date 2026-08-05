import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildMimecastClient, readMimecastSettings, resolveMimecastCredential, v1ErrorMessage } from '../../lib/mimecast'

const LIST = '/policy-management/cloud-gateway/v1/dns-authentication-outbound/definitions'

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
  const resp = await client.requestV1('GET', LIST, { query: { pageSize: 1 } })
  const latencyMs = Date.now() - start
  const passed = resp.ok

  checks.push({
    name: 'mimecast-dns-authentication-outbound-definition',
    passed,
    message: passed
      ? 'Reached the Mimecast DNS Authentication - Outbound definition endpoint'
      : `Mimecast error: ${resp.error ?? v1ErrorMessage(resp.body, resp.status)}`,
    latencyMs,
  })

  return { healthy: passed, score: passed ? 100 : 0, checks }
}
