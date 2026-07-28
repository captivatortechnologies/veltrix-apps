import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildIntuneClient } from '../../lib/intune'
import { readAssignments, type AssignmentSpec } from '../../lib/assignments'
import { attachDriftActor, veltrixActorLogins } from '../../lib/intuneAuditLog'
import { getFeatureUpdateProfile, listFeatureUpdateProfiles } from './deploy'
import {
  extractProfileSpecs,
  hasAnyAssignment,
  hasAnyRollout,
  normalizeDateTime,
  PROFILE_FIELDS,
  profileKey,
  readRolloutSettings,
} from './validate'

/**
 * Detect drift between the deployed feature update profiles and the live tenant. A
 * declared profile that no longer exists is critical drift; a managed field,
 * rollout offer value or assignment that differs from the declared value is warning
 * drift. Only the fields this canvas declares are compared — server-managed,
 * read-only state (createdDateTime, lastModifiedDateTime, deployableContentDisplayName,
 * endOfSupportDate) is never in the compare set, so it can never be reported as drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildIntuneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractProfileSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  // Veltrix's own app-only deploys appear under the app registration identity —
  // excluded so attribution reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = await listFeatureUpdateProfiles(client)
    const byName = new Map(live.filter((p) => p.displayName && p.id).map((p) => [profileKey(p.displayName as string), p]))

    for (const spec of specs) {
      const before = diffs.length
      const liveProfile = byName.get(profileKey(spec.name))
      if (!liveProfile || !liveProfile.id) {
        diffs.push({ field: `profile:${spec.name}`, expected: 'exists', actual: 'missing', severity: 'critical' })
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.name, excludeActorLogins })
        continue
      }
      const full = await getFeatureUpdateProfile(client, liveProfile.id)
      if (!full) continue

      const liveDescription = typeof full.description === 'string' ? full.description : ''
      if (spec.description !== liveDescription) {
        diffs.push({ field: `${spec.name}.description`, expected: spec.description, actual: liveDescription, severity: 'warning' })
      }

      for (const def of PROFILE_FIELDS) {
        if (!(def.key in spec.graph)) continue
        const want = spec.graph[def.key]
        const have = full[def.key]
        if (want !== have) {
          diffs.push({ field: `${spec.name}.${def.key}`, expected: want, actual: have ?? null, severity: 'warning' })
        }
      }

      if (hasAnyRollout(spec.rollout)) {
        const liveRollout = readRolloutSettings(full.rolloutSettings)
        if (normalizeDateTime(spec.rollout.startDate) !== normalizeDateTime(liveRollout.offerStartDateTimeInUTC)) {
          diffs.push({
            field: `${spec.name}.rolloutSettings.offerStartDateTimeInUTC`,
            expected: spec.rollout.startDate ?? null,
            actual: liveRollout.offerStartDateTimeInUTC ?? null,
            severity: 'warning',
          })
        }
        if (normalizeDateTime(spec.rollout.endDate) !== normalizeDateTime(liveRollout.offerEndDateTimeInUTC)) {
          diffs.push({
            field: `${spec.name}.rolloutSettings.offerEndDateTimeInUTC`,
            expected: spec.rollout.endDate ?? null,
            actual: liveRollout.offerEndDateTimeInUTC ?? null,
            severity: 'warning',
          })
        }
        if ((spec.rollout.intervalInDays ?? null) !== (liveRollout.offerIntervalInDays ?? null)) {
          diffs.push({
            field: `${spec.name}.rolloutSettings.offerIntervalInDays`,
            expected: spec.rollout.intervalInDays ?? null,
            actual: liveRollout.offerIntervalInDays ?? null,
            severity: 'warning',
          })
        }
      }

      if (hasAnyAssignment(spec.assignments)) {
        const haveAssign = readAssignments(full.assignments)
        if (assignmentsDiffer(spec.assignments, haveAssign)) {
          diffs.push({ field: `${spec.name}.assignments`, expected: 'as declared', actual: 'differs from declared', severity: 'warning' })
        }
      }

      // Attribute every diff this profile produced to the last human change (once);
      // a no-op (no query) when the profile did not drift.
      await attachDriftActor(client, diffs.slice(before), { targetId: liveProfile.id, targetName: spec.name, excludeActorLogins })
    }
  } catch (error) {
    diffs.push({ field: 'intune', expected: 'reachable', actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`, severity: 'critical' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}

/** Order-insensitive comparison of declared vs live assignment targets. */
function assignmentsDiffer(
  want: AssignmentSpec,
  have: { includeGroupIds: string[]; excludeGroupIds: string[]; allDevices: boolean; allUsers: boolean },
): boolean {
  const norm = (ids: string[]): string[] => [...ids].map((id) => id.toLowerCase()).sort()
  const sameList = (a: string[], b: string[]): boolean => {
    const x = norm(a)
    const y = norm(b)
    return x.length === y.length && x.every((v, i) => v === y[i])
  }
  return (
    !sameList(want.includeGroupIds, have.includeGroupIds) ||
    !sameList(want.excludeGroupIds, have.excludeGroupIds) ||
    Boolean(want.allDevices) !== have.allDevices ||
    Boolean(want.allUsers) !== have.allUsers
  )
}
