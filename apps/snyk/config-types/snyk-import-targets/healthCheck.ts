import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient } from '../../lib/snyk'
import { listTargets } from './deploy'
import { extractImportTargetSpecs, targetDisplayName } from './validate'

/**
 * Health check for import targets:
 *   1. Snyk API reachability + token/org validity (a targets list)
 *   2. Every declared target exists in the org
 * A freshly requested import may still be processing, in which case its target
 * is not yet listed; that reads as a failed check until the import completes.
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

  const start = Date.now()
  let live: Awaited<ReturnType<typeof listTargets>> | null = null
  try {
    live = await listTargets(client)
    checks.push({ name: 'snyk_reachable', passed: true, message: `Snyk API reachable at ${host}`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({ name: 'snyk_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (live) {
    const names = new Set(
      live
        .map((t) => t.attributes?.display_name)
        .filter((d): d is string => typeof d === 'string')
        .map((d) => d.toLowerCase()),
    )
    for (const spec of extractImportTargetSpecs(ctx.canvas).filter((s) => s.owner && s.name)) {
      const displayName = targetDisplayName(spec.owner, spec.name)
      const present = names.has(displayName.toLowerCase())
      checks.push({
        name: `target:${displayName}`,
        passed: present,
        message: present ? `Target "${displayName}" is imported` : `Target "${displayName}" is not present (import may still be processing)`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
