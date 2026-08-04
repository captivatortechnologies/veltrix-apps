import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { ersBase, buildErsResourceClient, readIseSettings, hasUsableCredential, MISSING_CREDENTIAL_MESSAGE, type Sgt } from '../../lib/iseApi'

export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheck[] = []
  if (!hasUsableCredential(ctx.credential)) return { healthy: false, score: 0, checks: [{ name: 'credential', passed: false, message: MISSING_CREDENTIAL_MESSAGE }] }
  const client = buildErsResourceClient<Sgt>(ersBase(ctx.component, ctx.connectivity, ctx.connectivityProvider), 'sgt', 'Sgt', ctx.credential, readIseSettings(ctx.settings))
  const started = Date.now()
  try {
    const { total } = await client.probe()
    checks.push({ name: 'ers_reachable', passed: true, message: `ISE ERS reachable (${total} Security Group Tag(s) known).`, latencyMs: Date.now() - started })
  } catch (error) {
    checks.push({ name: 'ers_reachable', passed: false, message: `ISE ERS unreachable or rejected the request: ${error instanceof Error ? error.message : 'error'}`, latencyMs: Date.now() - started })
  }
  return { healthy: checks.every((check) => check.passed), score: checks.filter((check) => check.passed).length / checks.length, checks }
}
