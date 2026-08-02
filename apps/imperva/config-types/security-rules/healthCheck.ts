import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildImpervaClient, ACCOUNT_PATH, isApiSuccess, apiMessage, parseJson, type ImpervaEnvelope } from '../../lib/impervaApi'

/**
 * Health for security-rules config = the Cloud WAF (Incapsula) API v1 answers to
 * an authenticated request. Read-only: POST /account. A `res === 0` envelope
 * confirms the endpoint resolves AND the API ID / API key authenticate.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheck[] = []

  const built = buildImpervaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    checks.push({ name: 'credential', passed: false, message: built.error })
    return { healthy: false, score: 0, checks }
  }
  const { client } = built

  const started = Date.now()
  try {
    const res = await client.post(ACCOUNT_PATH)
    const json = parseJson<ImpervaEnvelope>(res.body)
    const passed = res.ok && isApiSuccess(json)
    checks.push({
      name: 'imperva_reachable',
      passed,
      message: passed
        ? 'Imperva Cloud WAF API reachable and authenticated.'
        : `Imperva Cloud WAF API returned HTTP ${res.status}: ${apiMessage(json)}.`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'imperva_reachable',
      passed: false,
      message: `Imperva Cloud WAF API unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
