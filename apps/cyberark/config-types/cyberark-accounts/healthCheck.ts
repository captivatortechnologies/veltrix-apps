import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildCyberArkClient } from '../../lib/cyberark'
import { findAccount } from './deploy'
import { extractAccountSpecs } from './validate'

/**
 * Health check for account configuration:
 *   1. PVWA reachability + logon (a /Accounts search)
 *   2. Every declared account still exists (matched by name + safe)
 * Score is the percentage of passed checks (0–100).
 *
 * ⚠ Presence is checked by (name, safe) only — the secret is never read or verified.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildCyberArkClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'cyberark_credential', passed: false, message: built.error }] }
  }
  const { client, pvwaUrl } = built

  const start = Date.now()
  const specs = extractAccountSpecs(ctx.canvas).filter((s) => s.name && s.safeName)

  try {
    let first = true
    for (const spec of specs) {
      const live = await findAccount(client, spec)
      if (first) {
        checks.push({ name: 'cyberark_reachable', passed: true, message: `PVWA reachable at ${pvwaUrl}`, latencyMs: Date.now() - start })
        first = false
      }
      const present = live !== null
      checks.push({
        name: `account:${spec.name}@${spec.safeName}`,
        passed: present,
        message: present ? `Account "${spec.name}" is present in "${spec.safeName}"` : `Account "${spec.name}" is missing in "${spec.safeName}"`,
      })
    }
    if (specs.length === 0) {
      // No declared accounts — still prove reachability with an empty search.
      await findAccount(client, { name: '', safeName: '' })
      checks.push({ name: 'cyberark_reachable', passed: true, message: `PVWA reachable at ${pvwaUrl}`, latencyMs: Date.now() - start })
    }
  } catch (error) {
    checks.push({ name: 'cyberark_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  await client.logoff()
  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passedCount / checks.length) * 100) : 0
  return { healthy: passedCount === checks.length, score, checks }
}
