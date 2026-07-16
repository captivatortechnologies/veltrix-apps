import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCyberArkClient } from '../../lib/cyberark'
import { listMembers, resolveSafeUrlId } from './deploy'
import { enabledPermissions, extractSafeMemberSpecs, type LiveSafeMember } from './validate'

/**
 * Detect drift between the deployed safe-member configuration and the live PVWA.
 * Re-finds each declared member on its safe and diffs the granted permissions and
 * expiration; a missing member is critical drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildCyberArkClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractSafeMemberSpecs(ctx.deployedConfig).filter((s) => s.safeName && s.memberName)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const safeUrlIds = new Map<string, string>()
    const membersBySafe = new Map<string, Map<string, LiveSafeMember>>()

    for (const spec of specs) {
      const safeUrlId = await resolveSafeUrlId(client, spec.safeName, safeUrlIds)
      if (!membersBySafe.has(safeUrlId)) {
        const members = await listMembers(client, safeUrlId)
        membersBySafe.set(safeUrlId, new Map(members.filter((m) => m.memberName).map((m) => [(m.memberName as string).toLowerCase(), m])))
      }
      const found = membersBySafe.get(safeUrlId)!.get(spec.memberName.toLowerCase())
      const tag = `${spec.memberName}@${spec.safeName}`
      if (!found) {
        diffs.push({ field: tag, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      const livePerms = new Set(enabledPermissions(found.permissions))
      const wantPerms = new Set(spec.permissions)
      const missing = [...wantPerms].filter((p) => !livePerms.has(p))
      const extra = [...livePerms].filter((p) => !wantPerms.has(p))
      if (missing.length > 0 || extra.length > 0) {
        diffs.push({
          field: `${tag}.permissions`,
          expected: [...wantPerms].sort().join(', ') || '(none)',
          actual: [...livePerms].sort().join(', ') || '(none)',
          severity: 'warning',
        })
      }
      if ((found.membershipExpirationDate ?? null) !== spec.membershipExpiration) {
        diffs.push({
          field: `${tag}.expiration`,
          expected: spec.membershipExpiration ?? 'never',
          actual: found.membershipExpirationDate ?? 'never',
          severity: 'info',
        })
      }
    }
  } catch (error) {
    diffs.push({
      field: 'cyberark',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  await client.logoff()
  return { hasDrift: diffs.length > 0, diffs }
}
