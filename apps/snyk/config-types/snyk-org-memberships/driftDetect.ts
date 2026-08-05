import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient } from '../../lib/snyk'
import { attachDriftActor, veltrixActorLogins } from '../../lib/snykAuditLog'
import { listMemberships } from './deploy'
import { extractMembershipSpecs, membershipKey, type LiveMembership } from './validate'

/** Snyk audit event-name prefixes for org-membership changes (best-effort attribution). */
const MEMBERSHIP_EVENT_PREFIXES = ['org.membership', 'group.membership']

/**
 * Detect drift between the deployed memberships and the live org. A declared
 * membership that no longer exists is critical drift; a role id that no
 * longer matches is a warning.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildSnykClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built
  if (!client.hasOrg) return { hasDrift: false, diffs: [] }

  const specs = extractMembershipSpecs(ctx.deployedConfig).filter((s) => s.userId)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listMemberships(client)
    const excludeActorLogins = veltrixActorLogins(ctx.credential)
    const byUser = new Map<string, LiveMembership>(
      live.filter((m) => m.relationships?.user?.data?.id).map((m) => [membershipKey(m.relationships!.user!.data!.id as string), m]),
    )

    for (const spec of specs) {
      const before = diffs.length
      const found = byUser.get(membershipKey(spec.userId))
      const label = spec.email ? `${spec.userId} (${spec.email})` : spec.userId

      if (!found) {
        diffs.push({ field: `membership:${label}`, expected: 'exists', actual: 'missing', severity: 'critical' })
      } else {
        const liveRoleId = found.relationships?.role?.data?.id
        if (spec.roleId && liveRoleId && liveRoleId !== spec.roleId) {
          diffs.push({
            field: `membership:${label}.role_id`,
            expected: spec.roleId,
            actual: liveRoleId,
            severity: 'warning',
          })
        }
      }

      await attachDriftActor(client, diffs.slice(before), {
        targetId: found?.id,
        targetName: spec.userId,
        eventPrefixes: MEMBERSHIP_EVENT_PREFIXES,
        excludeActorLogins,
      })
    }
  } catch (error) {
    diffs.push({
      field: 'snyk',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
