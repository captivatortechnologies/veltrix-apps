import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import {
  buildMimecastClient,
  mimecastErrorMessage,
  readMimecastSettings,
  resolveMimecastCredential,
} from '../../lib/mimecast'

const GET = '/api/policy/address-alteration/get-definition'

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
  // get-definition needs at least one criterion — a routing filter is the
  // lightest well-formed query that just confirms the endpoint is reachable.
  const resp = await client.request(GET, { routing: 'all' })
  const latencyMs = Date.now() - start
  const passed = resp.ok

  checks.push({
    name: 'mimecast-address-alteration-definition',
    passed,
    message: passed ? 'Reached the Mimecast address alteration definition endpoint' : `Mimecast error: ${mimecastErrorMessage(resp)}`,
    latencyMs,
  })

  return { healthy: passed, score: passed ? 100 : 0, checks }
}
