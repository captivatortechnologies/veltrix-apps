import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildCyberArkClient } from '../../lib/cyberark'
import { listSafes } from './deploy'
import { extractSafeSpecs, safeKey, type LiveSafe } from './validate'

/**
 * Health check for safe configuration:
 *   1. PVWA reachability + logon (a paged /Safes list)
 *   2. Every declared safe (by name) still exists
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildCyberArkClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'cyberark_credential', passed: false, message: built.error }] }
  }
  const { client, pvwaUrl } = built

  const start = Date.now()
  let live: LiveSafe[] | null = null
  try {
    live = await listSafes(client)
    checks.push({ name: 'cyberark_reachable', passed: true, message: `PVWA reachable at ${pvwaUrl}`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({ name: 'cyberark_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (live) {
    const keys = new Set(live.filter((s) => s.safeName).map((s) => safeKey({ safeName: s.safeName as string })))
    for (const spec of extractSafeSpecs(ctx.canvas).filter((s) => s.safeName)) {
      const present = keys.has(safeKey(spec))
      checks.push({
        name: `safe:${spec.safeName}`,
        passed: present,
        message: present ? `Safe "${spec.safeName}" is present` : `Safe "${spec.safeName}" is missing`,
      })
    }
  }

  await client.logoff()
  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passedCount / checks.length) * 100) : 0
  return { healthy: passedCount === checks.length, score, checks }
}
