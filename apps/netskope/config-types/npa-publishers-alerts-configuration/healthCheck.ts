import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import {
  buildNetskopeClient,
  netskopeErrorMessage,
  readNetskopeSettings,
  resolveNetskopeCredential,
} from '../../lib/netskope'

const BASE = '/infrastructure/publishers/alertsconfiguration'

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
  const resp = await client.get(BASE)
  const latencyMs = Date.now() - start
  // A tenant that has never configured this endpoint returns 404 — that is
  // still a reachable, healthy endpoint, so only treat it as a failure below 400.
  const passed = resp.ok || resp.status === 404

  checks.push({
    name: 'netskope-npa-publishers-alerts-configuration',
    passed,
    message: passed ? 'Reached the Netskope NPA publisher alerts configuration endpoint' : `Netskope error: ${netskopeErrorMessage(resp)}`,
    latencyMs,
  })

  return { healthy: passed, score: passed ? 100 : 0, checks }
}
