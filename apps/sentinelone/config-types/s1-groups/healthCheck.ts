import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildS1Client, MISSING_SCOPE_MESSAGE } from '../../lib/s1'
import { listGroups } from './deploy'
import { extractGroupSpecs, GROUPS_REQUIRE_SITE_SCOPE, type LiveGroup } from './validate'

/**
 * Health check for group configuration:
 *   1. The app is configured at the `site` scope (groups are site-scoped)
 *   2. SentinelOne API reachability + credential/scope validity (a scoped list)
 *   3. Every declared group still exists at the site
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildS1Client(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 's1_credential', passed: false, message: built.error }] }
  }
  const { client, consoleUrl } = built
  if (!client.hasScope) {
    return { healthy: false, score: 0, checks: [{ name: 's1_scope', passed: false, message: MISSING_SCOPE_MESSAGE }] }
  }
  if (client.currentScope !== 'site') {
    return {
      healthy: false,
      score: 0,
      checks: [{ name: 's1_site_scope', passed: false, message: GROUPS_REQUIRE_SITE_SCOPE }],
    }
  }

  const specs = extractGroupSpecs(ctx.canvas).filter((s) => s.name)

  const reachable = await timedCheck('s1_reachable', async () => {
    const live = await listGroups(client)
    return { message: `SentinelOne reachable at ${consoleUrl} (site scope)`, live }
  })
  checks.push({ name: reachable.name, passed: reachable.passed, message: reachable.message, latencyMs: reachable.latencyMs })

  if (reachable.passed && reachable.live) {
    const names = new Set(reachable.live.filter((g) => g.name).map((g) => g.name as string))
    for (const spec of specs) {
      const present = names.has(spec.name)
      checks.push({
        name: `group:${spec.name}`,
        passed: present,
        message: present ? `Group "${spec.name}" is present` : `Group "${spec.name}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}

async function timedCheck(
  name: string,
  fn: () => Promise<{ message: string; live?: LiveGroup[] }>,
): Promise<{ name: string; passed: boolean; message: string; latencyMs: number; live?: LiveGroup[] }> {
  const start = Date.now()
  try {
    const { message, live } = await fn()
    return { name, passed: true, message, latencyMs: Date.now() - start, live }
  } catch (error) {
    return { name, passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start }
  }
}
