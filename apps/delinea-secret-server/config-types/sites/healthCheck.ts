import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildSecretServerClient, secretServerErrorMessage } from '../../lib/secretServerApi'
import { extractSiteSpecs, searchSites, findSiteByName } from './_shared'

/**
 * Health for sites config:
 *   1. Secret Server reachability + OAuth2 logon (GET /api/v1/distributed-engine/sites?take=1)
 *   2. Every declared site (by name) still exists
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheck[] = []

  const built = buildSecretServerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'credential', passed: false, message: built.error }] }
  }
  const { client, apiBase } = built

  const started = Date.now()
  let reachable = false
  try {
    const res = await client.request('GET', '/distributed-engine/sites', { query: { take: 1 } })
    reachable = res.ok
    checks.push({
      name: 'secretserver_reachable',
      passed: res.ok,
      message: res.ok ? `Secret Server reachable at ${apiBase}` : `Secret Server returned HTTP ${res.status}: ${secretServerErrorMessage(res)}`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'secretserver_reachable',
      passed: false,
      message: `Secret Server unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  if (reachable) {
    const specs = extractSiteSpecs(ctx.canvas.items ?? ctx.canvas.sections ?? []).filter((s) => s.siteName)
    for (const spec of specs) {
      try {
        const matches = await searchSites(client, spec.siteName)
        const present = findSiteByName(matches, spec.siteName) !== null
        checks.push({
          name: `site:${spec.siteName}`,
          passed: present,
          message: present ? `Site "${spec.siteName}" is present` : `Site "${spec.siteName}" is missing`,
        })
      } catch (error) {
        checks.push({ name: `site:${spec.siteName}`, passed: false, message: error instanceof Error ? error.message : 'check failed' })
      }
    }
  }

  const passed = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passed / checks.length) * 100) : 0
  return { healthy: passed === checks.length, score, checks }
}
