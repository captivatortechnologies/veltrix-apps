import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildIntuneClient } from '../../lib/intune'
import { listScopeTags } from './deploy'
import { extractScopeTagSpecs, scopeTagKey } from './validate'

/**
 * Health check for role scope tags:
 *   1. Graph reachability + token/permission validity (a scope tags list)
 *   2. Every declared tag still exists (matched by displayName)
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildIntuneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'intune_credential', passed: false, message: built.error }] }
  }
  const { client, graphHost } = built

  const start = Date.now()
  let live: Awaited<ReturnType<typeof listScopeTags>> | null = null
  try {
    live = await listScopeTags(client)
    checks.push({ name: 'graph_reachable', passed: true, message: `Microsoft Graph reachable at ${graphHost}`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({ name: 'graph_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (live) {
    const names = new Set(live.filter((t) => t.displayName).map((t) => scopeTagKey(t.displayName as string)))
    for (const spec of extractScopeTagSpecs(ctx.canvas).filter((s) => s.name)) {
      const present = names.has(scopeTagKey(spec.name))
      checks.push({
        name: `scopeTag:${spec.name}`,
        passed: present,
        message: present ? `Role scope tag "${spec.name}" is present` : `Role scope tag "${spec.name}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
