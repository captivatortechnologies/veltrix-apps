import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildCyberArkClient } from '../../lib/cyberark'
import { mapGroups } from './deploy'
import { extractVaultGroupSpecs, vaultGroupKey, type LiveVaultGroup } from './validate'

/**
 * Health check for Vault-group configuration:
 *   1. PVWA reachability + logon (a /UserGroups list)
 *   2. Every declared group (by name) still exists
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
  let byKey: Map<string, LiveVaultGroup> | null = null
  try {
    byKey = await mapGroups(client)
    checks.push({ name: 'cyberark_reachable', passed: true, message: `PVWA reachable at ${pvwaUrl}`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({ name: 'cyberark_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (byKey) {
    for (const spec of extractVaultGroupSpecs(ctx.canvas).filter((s) => s.groupName)) {
      const present = byKey.has(vaultGroupKey(spec))
      checks.push({
        name: `group:${spec.groupName}`,
        passed: present,
        message: present ? `Group "${spec.groupName}" is present` : `Group "${spec.groupName}" is missing`,
      })
    }
  }

  await client.logoff()
  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passedCount / checks.length) * 100) : 0
  return { healthy: passedCount === checks.length, score, checks }
}
