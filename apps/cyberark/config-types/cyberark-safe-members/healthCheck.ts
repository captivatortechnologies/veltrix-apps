import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildCyberArkClient } from '../../lib/cyberark'
import { listMembers, resolveSafeUrlId } from './deploy'
import { extractSafeMemberSpecs } from './validate'

/**
 * Health check for safe-member configuration:
 *   1. PVWA reachability + logon
 *   2. Every declared member still exists on its safe (matched by name)
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
  const safeUrlIds = new Map<string, string>()
  const specs = extractSafeMemberSpecs(ctx.canvas).filter((s) => s.safeName && s.memberName)

  try {
    // A single safe resolution proves reachability + logon.
    if (specs.length > 0) await resolveSafeUrlId(client, specs[0].safeName, safeUrlIds)
    checks.push({ name: 'cyberark_reachable', passed: true, message: `PVWA reachable at ${pvwaUrl}`, latencyMs: Date.now() - start })

    const membersBySafe = new Map<string, Set<string>>()
    for (const spec of specs) {
      const safeUrlId = await resolveSafeUrlId(client, spec.safeName, safeUrlIds)
      if (!membersBySafe.has(safeUrlId)) {
        const members = await listMembers(client, safeUrlId)
        membersBySafe.set(safeUrlId, new Set(members.filter((m) => m.memberName).map((m) => (m.memberName as string).toLowerCase())))
      }
      const present = membersBySafe.get(safeUrlId)!.has(spec.memberName.toLowerCase())
      checks.push({
        name: `member:${spec.memberName}@${spec.safeName}`,
        passed: present,
        message: present ? `Member "${spec.memberName}" is present on "${spec.safeName}"` : `Member "${spec.memberName}" is missing on "${spec.safeName}"`,
      })
    }
  } catch (error) {
    checks.push({ name: 'cyberark_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  await client.logoff()
  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passedCount / checks.length) * 100) : 0
  return { healthy: passedCount === checks.length, score, checks }
}
