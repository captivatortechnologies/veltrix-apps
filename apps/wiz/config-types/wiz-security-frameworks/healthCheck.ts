import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildWizClient } from '../../lib/wiz'
import { listCustomSecurityFrameworks } from './deploy'
import { extractSecurityFrameworkSpecs, frameworkKey, type LiveSecurityFramework } from './validate'

/**
 * Health check for security-framework configuration:
 *   1. Wiz GraphQL reachability + credential validity (a frameworks list)
 *   2. Every declared framework (by name) still exists as a custom framework
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildWizClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'wiz_credential', passed: false, message: built.error }] }
  }
  const { client, graphqlUrl } = built

  const specs = extractSecurityFrameworkSpecs(ctx.canvas).filter((s) => s.name && Array.isArray(s.categories))

  const reachable = await timedCheck('wiz_reachable', async () => {
    const live = await listCustomSecurityFrameworks(client)
    return { message: `Wiz reachable at ${graphqlUrl}`, live }
  })
  checks.push({ name: reachable.name, passed: reachable.passed, message: reachable.message, latencyMs: reachable.latencyMs })

  if (reachable.passed && reachable.live) {
    const names = new Set(reachable.live.filter((f) => f.name).map((f) => frameworkKey(f.name as string)))
    for (const spec of specs) {
      const present = names.has(frameworkKey(spec.name))
      checks.push({
        name: `framework:${spec.name}`,
        passed: present,
        message: present ? `Security framework "${spec.name}" is present` : `Security framework "${spec.name}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}

async function timedCheck(
  name: string,
  fn: () => Promise<{ message: string; live?: LiveSecurityFramework[] }>,
): Promise<{ name: string; passed: boolean; message: string; latencyMs: number; live?: LiveSecurityFramework[] }> {
  const start = Date.now()
  try {
    const { message, live } = await fn()
    return { name, passed: true, message, latencyMs: Date.now() - start, live }
  } catch (error) {
    return { name, passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start }
  }
}
