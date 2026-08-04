import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildSecretServerClient, secretServerErrorMessage } from '../../lib/secretServerApi'
import { extractConnectorSpecs, searchConnectors, findConnectorByName } from './_shared'

/**
 * Health for connection-managers config:
 *   1. Secret Server reachability + OAuth2 logon (GET /api/v1/distributed-engine/site-connectors?take=1)
 *   2. Every declared connection manager (by name) still exists
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
  let allConnectors: Awaited<ReturnType<typeof searchConnectors>> = []
  try {
    const res = await client.request('GET', '/distributed-engine/site-connectors', { query: { take: 1 } })
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
    const specs = extractConnectorSpecs(ctx.canvas.items ?? ctx.canvas.sections ?? []).filter((s) => s.name)
    try {
      allConnectors = await searchConnectors(client)
    } catch (error) {
      checks.push({ name: 'connection_managers_list', passed: false, message: error instanceof Error ? error.message : 'list failed' })
    }
    for (const spec of specs) {
      const present = findConnectorByName(allConnectors, spec.name) !== null
      checks.push({
        name: `connection-manager:${spec.name}`,
        passed: present,
        message: present ? `Connection manager "${spec.name}" is present` : `Connection manager "${spec.name}" is missing`,
      })
    }
  }

  const passed = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passed / checks.length) * 100) : 0
  return { healthy: passed === checks.length, score, checks }
}
