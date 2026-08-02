import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildDarktraceUrl, darktraceAuthFrom, buildQuery, requestUri, darktraceFetch } from '../../lib/darktraceApi'

/**
 * Health for the tags config = Darktrace answers a DSA-signed read with the
 * configured token pair. Read-only + lightweight: GET /tags?responsedata=name
 * (restricts the reply to just the tag names, not full tag objects). A 2xx confirms
 * reachability AND that the DSA signature validates; a 3xx/4xx below 500 still
 * proves the endpoint is reachable (auth nuances surface at deploy time).
 * Verify against a live Darktrace.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const checks: HealthCheck[] = []

  const auth = darktraceAuthFrom(credential)
  if (!auth) {
    checks.push({ name: 'credential', passed: false, message: 'No Darktrace token pair (public + private) attached to this connection.' })
    return { healthy: false, score: 0, checks }
  }

  const base = buildDarktraceUrl(component, connectivity, connectivityProvider)
  const uri = requestUri('/tags', buildQuery({ responsedata: 'name' }))
  const started = Date.now()
  try {
    const res = await darktraceFetch(base, uri, auth, { timeoutMs: 8000 })
    const passed = res.status > 0 && res.status < 500
    checks.push({
      name: 'darktrace_reachable',
      passed,
      message: passed ? `Darktrace reachable (HTTP ${res.status}).` : `Darktrace returned HTTP ${res.status}.`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'darktrace_reachable',
      passed: false,
      message: `Darktrace unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
