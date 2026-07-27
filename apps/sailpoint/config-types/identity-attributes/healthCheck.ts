import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import {
  buildIscClient,
  iscErrorMessage,
  readIscSettings,
  resolveIscCredential,
} from '../../lib/isc'

const BASE = '/beta/identity-attributes'

export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []
  const settings = readIscSettings(ctx.settings)
  const cred = resolveIscCredential(ctx.credential, settings)

  if (!cred) {
    checks.push({ name: 'credential', passed: false, message: 'No usable SailPoint ISC credential / tenant configured' })
    return { healthy: false, score: 0, checks }
  }

  const client = buildIscClient(cred, settings)
  const start = Date.now()
  const resp = await client.get(BASE)
  const latencyMs = Date.now() - start
  const passed = resp.ok

  checks.push({
    name: 'isc-identity-attributes',
    passed,
    message: passed ? 'Reached the ISC identity-attributes endpoint' : `ISC error: ${iscErrorMessage(resp)}`,
    latencyMs,
  })

  return { healthy: passed, score: passed ? 100 : 0, checks }
}
