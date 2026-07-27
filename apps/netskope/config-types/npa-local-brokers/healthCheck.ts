import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import {
  buildNetskopeClient,
  netskopeErrorMessage,
  readNetskopeSettings,
  resolveNetskopeCredential,
} from '../../lib/netskope'

const BASE = '/infrastructure/lbrokers'

export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []
  const settings = readNetskopeSettings(ctx.settings)
  const cred = resolveNetskopeCredential(ctx.credential, settings)

  if (!cred) {
    checks.push({ name: 'credential', passed: false, message: 'No usable Netskope credential / tenant configured' })
    return { healthy: false, score: 0, checks }
  }

  const client = buildNetskopeClient(cred, settings)
  const start = Date.now()
  const resp = await client.get(`${BASE}?limit=1&offset=0`)
  const latencyMs = Date.now() - start
  const passed = resp.ok

  checks.push({
    name: 'netskope-npa-local-brokers',
    passed,
    message: passed ? 'Reached the Netskope NPA local brokers endpoint' : `Netskope error: ${netskopeErrorMessage(resp)}`,
    latencyMs,
  })

  return { healthy: passed, score: passed ? 100 : 0, checks }
}
