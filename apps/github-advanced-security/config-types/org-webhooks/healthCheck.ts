import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildGithubClient } from '../../lib/githubApi'

/**
 * Health for the org-webhooks config = GitHub answers on its REST API with the
 * configured token. Read-only: GET /user. A 401/403 means the token is bad,
 * surfaced as a failed check.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const { component, credential, settings } = ctx
  const checks: HealthCheck[] = []

  const built = buildGithubClient(component.hostname, credential, settings ?? {})
  if ('error' in built) {
    checks.push({ name: 'credential', passed: false, message: built.error })
    return { healthy: false, score: 0, checks }
  }

  const started = Date.now()
  try {
    const res = await built.client.getAuthenticatedUser()
    const passed = res.ok
    checks.push({
      name: 'github_reachable',
      passed,
      message: passed
        ? `GitHub reachable and token valid (HTTP ${res.status}).`
        : `GitHub returned HTTP ${res.status} for GET /user — check the token.`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'github_reachable',
      passed: false,
      message: `GitHub unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
