import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildAxoniusUrl, buildAuthHeaders, apiUrl, axoniusRequest, verifyTls } from '../../lib/axoniusApi'
import { META_ABOUT_RESOURCE } from './_shared'

/**
 * Health for the enforcement-sets config = Axonius answers on its REST API with
 * the configured API key + secret. Read-only: GET api/settings/meta/about. Any
 * response below 500 counts as reachable (auth nuances surface at deploy time,
 * not here). Verify the endpoint against a live Axonius tenant.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const { component, credential, connectivity, connectivityProvider, settings } = ctx
  const checks: HealthCheck[] = []

  if (!credential) {
    checks.push({ name: 'credential', passed: false, message: 'No credential attached to this connection.' })
    return { healthy: false, score: 0, checks }
  }

  const headers = buildAuthHeaders(credential)
  if (Object.keys(headers).length !== 2) {
    checks.push({ name: 'credential', passed: false, message: 'Axonius needs both an API key and an API secret.' })
    return { healthy: false, score: 0, checks }
  }

  const base = buildAxoniusUrl(component, connectivity, connectivityProvider)
  const started = Date.now()
  try {
    const res = await axoniusRequest(apiUrl(base, settings, META_ABOUT_RESOURCE), {
      headers,
      timeoutMs: 8000,
      verifyTls: verifyTls(settings),
    })
    const passed = res.status > 0 && res.status < 500
    checks.push({
      name: 'axonius_reachable',
      passed,
      message: passed ? `Axonius reachable (HTTP ${res.status}).` : `Axonius returned HTTP ${res.status}.`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'axonius_reachable',
      passed: false,
      message: `Axonius unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
