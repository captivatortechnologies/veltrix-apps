import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { readIllumioSettings, resolveIllumioCredential, buildIllumioBaseUrl, secPolicyDraftPath, basicAuthHeader, illumioRequest } from '../../lib/illumioApi'

export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []
  const settings = readIllumioSettings(ctx.settings)
  const base = buildIllumioBaseUrl(settings)
  const cred = resolveIllumioCredential(ctx.credential)

  if (!base || !cred) {
    checks.push({ name: 'credential', passed: false, message: 'No usable PCE host / credential configured' })
    return { healthy: false, score: 0, checks }
  }

  const headers = basicAuthHeader(cred)
  const start = Date.now()
  try {
    const res = await illumioRequest(`${base}${secPolicyDraftPath(settings, 'ip_lists')}?max_results=1`, {
      headers,
      timeoutMs: settings.timeoutMs,
      verifyTls: settings.verifyTls,
    })
    const latencyMs = Date.now() - start
    const passed = res.ok
    checks.push({
      name: 'illumio-ip-lists',
      passed,
      message: passed
        ? `Reached the PCE draft IP lists endpoint for org ${settings.orgId}`
        : `PCE returned HTTP ${res.status}: ${res.body.slice(0, 200)}`,
      latencyMs,
    })
  } catch (error) {
    checks.push({
      name: 'illumio-ip-lists',
      passed: false,
      message: `PCE unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - start,
    })
  }

  const passed = checks.every((c) => c.passed)
  return { healthy: passed, score: passed ? 100 : 0, checks }
}
