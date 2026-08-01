import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildSecretServerClient, secretServerErrorMessage } from '../../lib/secretServerApi'
import { extractPolicySpecs, searchPolicies, findPolicyByName } from './_shared'

/**
 * Health for secret-policies config:
 *   1. Secret Server reachability + OAuth2 logon (GET /api/v1/secret-policy/search?take=1)
 *   2. Every declared policy (by name) still exists
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
    const res = await client.request('GET', '/secret-policy/search', { query: { take: 1 } })
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
    const specs = extractPolicySpecs(ctx.canvas.items ?? ctx.canvas.sections ?? []).filter((s) => s.secretPolicyName)
    for (const spec of specs) {
      try {
        const matches = await searchPolicies(client, spec.secretPolicyName)
        const present = findPolicyByName(matches, spec.secretPolicyName) !== null
        checks.push({
          name: `policy:${spec.secretPolicyName}`,
          passed: present,
          message: present ? `Secret policy "${spec.secretPolicyName}" is present` : `Secret policy "${spec.secretPolicyName}" is missing`,
        })
      } catch (error) {
        checks.push({ name: `policy:${spec.secretPolicyName}`, passed: false, message: error instanceof Error ? error.message : 'check failed' })
      }
    }
  }

  const passed = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passed / checks.length) * 100) : 0
  return { healthy: passed === checks.length, score, checks }
}
