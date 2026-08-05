import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient } from '../../lib/snyk'
import { readProject } from './deploy'
import { extractProjectAttributesSpecs } from './validate'

/**
 * Health check for project-attributes configuration:
 *   1. Snyk API reachability + token/org validity (the first project read)
 *   2. Every declared project id resolves to a readable project in the org
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

  const specs = extractProjectAttributesSpecs(ctx.canvas).filter((s) => s.projectId)
  let reachable = false
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]
    const start = Date.now()
    try {
      await readProject(client, spec.projectId)
      if (!reachable) {
        checks.push({ name: 'snyk_reachable', passed: true, message: `Snyk API reachable at ${host}`, latencyMs: Date.now() - start })
        reachable = true
      }
      checks.push({ name: `project:${spec.projectId}`, passed: true, message: `Project "${spec.projectId}" is readable` })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Check failed'
      if (!reachable && i === 0) {
        checks.push({ name: 'snyk_reachable', passed: false, message, latencyMs: Date.now() - start })
      }
      checks.push({ name: `project:${spec.projectId}`, passed: false, message: `Project "${spec.projectId}" is not readable: ${message}` })
    }
  }

  if (checks.length === 0) {
    checks.push({ name: 'snyk_reachable', passed: false, message: 'No projects declared' })
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
