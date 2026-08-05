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
  // Grants have no list-all endpoint; the Users endpoint (used to resolve a
  // principal email to a login_id) is the reachability check this type
  // actually depends on.
  const start = Date.now()
  const resp = await client.get(client.usersPath())
  const latencyMs = Date.now() - start
  const passed = resp.ok

  checks.push({
    name: 'cbc-access-grants',
    passed,
    message: passed ? 'Reached the Carbon Black Users endpoint' : `Carbon Black error: ${cbErrorMessage(resp)}`,
    latencyMs,
  })

  return { healthy: passed, score: passed ? 100 : 0, checks }
}
