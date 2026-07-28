import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildIntuneClient } from '../../lib/intune'
import { listScripts } from './deploy'
import { extractScriptSpecs, scriptKey } from './validate'

/**
 * Health check for Intune platform scripts:
 *   1. Graph reachability + token/permission validity (a device-management-scripts list)
 *   2. Every declared script still exists
 * Score is the percentage of passed checks (0-100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildIntuneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'intune_credential', passed: false, message: built.error }] }
  }
  const { client, graphHost } = built

  const start = Date.now()
  let live: Awaited<ReturnType<typeof listScripts>> | null = null
  try {
    live = await listScripts(client)
    checks.push({ name: 'graph_reachable', passed: true, message: `Microsoft Graph reachable at ${graphHost}`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({ name: 'graph_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (live) {
    const names = new Set(live.filter((s) => s.displayName).map((s) => scriptKey(s.displayName as string)))
    for (const spec of extractScriptSpecs(ctx.canvas).filter((s) => s.name)) {
      const present = names.has(scriptKey(spec.name))
      checks.push({
        name: `script:${spec.name}`,
        passed: present,
        message: present ? `Platform script "${spec.name}" is present` : `Platform script "${spec.name}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
