import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildCyberArkClient } from '../../lib/cyberark'
import { mapGroupsBySafe } from './deploy'
import { extractAccountGroupSpecs, type LiveAccountGroup } from './validate'

/**
 * Health check for account-group configuration:
 *   1. PVWA reachability + logon (an AccountGroups list per referenced safe)
 *   2. Every declared group (by safe + name) still exists
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildCyberArkClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'cyberark_credential', passed: false, message: built.error }] }
  }
  const { client, pvwaUrl } = built

  const specs = extractAccountGroupSpecs(ctx.canvas).filter((s) => s.groupName && s.safeName)
  const start = Date.now()
  const bySafe = new Map<string, Map<string, LiveAccountGroup>>()
  let reachable = false

  try {
    for (const spec of specs) {
      const safeLower = spec.safeName.toLowerCase()
      if (!bySafe.has(safeLower)) bySafe.set(safeLower, await mapGroupsBySafe(client, spec.safeName))
    }
    reachable = true
    checks.push({ name: 'cyberark_reachable', passed: true, message: `PVWA reachable at ${pvwaUrl}`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({ name: 'cyberark_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (reachable) {
    for (const spec of specs) {
      const present = !!bySafe.get(spec.safeName.toLowerCase())?.has(spec.groupName.toLowerCase())
      checks.push({
        name: `group:${spec.groupName}@${spec.safeName}`,
        passed: present,
        message: present ? `Group "${spec.groupName}" @ "${spec.safeName}" is present` : `Group "${spec.groupName}" @ "${spec.safeName}" is missing`,
      })
    }
  }

  await client.logoff()
  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passedCount / checks.length) * 100) : 0
  return { healthy: passedCount === checks.length, score, checks }
}
