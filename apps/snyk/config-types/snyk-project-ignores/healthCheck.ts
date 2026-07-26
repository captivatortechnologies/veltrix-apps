import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient } from '../../lib/snyk'
import { readIssueIgnore } from './deploy'
import { extractIgnoreSpecs } from './validate'

/**
 * Health check for project ignores:
 *   1. Snyk API reachability + token/org validity (the first declared issue)
 *   2. Every declared ignore is still present on its issue
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildSnykClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'snyk_credential', passed: false, message: built.error }] }
  }
  const { client, host } = built
  if (!client.hasOrg) {
    return { healthy: false, score: 0, checks: [{ name: 'snyk_org', passed: false, message: 'No Snyk organization id set' }] }
  }

  const specs = extractIgnoreSpecs(ctx.canvas).filter((s) => s.projectId && s.issueId)
  let reachable = false
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]
    const start = Date.now()
    try {
      const rules = await readIssueIgnore(client, spec.projectId, spec.issueId)
      if (!reachable) {
        checks.push({ name: 'snyk_reachable', passed: true, message: `Snyk API reachable at ${host}`, latencyMs: Date.now() - start })
        reachable = true
      }
      const present = rules.length > 0
      checks.push({
        name: `ignore:${spec.projectId}:${spec.issueId}`,
        passed: present,
        message: present ? `Issue "${spec.issueId}" is ignored` : `Issue "${spec.issueId}" is no longer ignored`,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Check failed'
      if (!reachable && i === 0) {
        checks.push({ name: 'snyk_reachable', passed: false, message, latencyMs: Date.now() - start })
      }
      checks.push({ name: `ignore:${spec.projectId}:${spec.issueId}`, passed: false, message })
    }
  }

  if (checks.length === 0) {
    checks.push({ name: 'snyk_reachable', passed: false, message: 'No ignores declared' })
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
