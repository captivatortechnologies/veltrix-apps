import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildIntuneClient } from '../../lib/intune'
import { readAssignments, type AssignmentSpec } from '../../lib/assignments'
import { attachDriftActor, veltrixActorLogins } from '../../lib/intuneAuditLog'
import { getQualityUpdateProfile, listQualityUpdateProfiles } from './deploy'
import { extractProfileSpecs, hasAnyAssignment, profileKey } from './validate'

/**
 * Detect drift between the deployed quality update profiles and the live tenant. A
 * declared profile that no longer exists is critical drift; a managed field
 * (release, forced-reboot grace, description) or assignment that differs from the
 * declared value is warning drift. Only the fields this canvas declares are
 * compared — read-only server state (created/lastModified timestamps,
 * releaseDateDisplayName, deployableContentDisplayName) is never in the compare set.
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
    const live = await listQualityUpdateProfiles(client)
    const byName = new Map(live.filter((p) => p.displayName && p.id).map((p) => [profileKey(p.displayName as string), p]))

    for (const spec of specs) {
      const before = diffs.length
      const liveProfile = byName.get(profileKey(spec.name))
      if (!liveProfile || !liveProfile.id) {
        diffs.push({ field: `profile:${spec.name}`, expected: 'exists', actual: 'missing', severity: 'critical' })
        // Deleted/absent — no live id; attribute the deletion by name (best-effort).
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.name, excludeActorLogins })
        continue
      }
      const full = await getQualityUpdateProfile(client, liveProfile.id)
      if (!full) continue

      const liveDescription = typeof full.description === 'string' ? full.description : ''
      if (spec.description !== liveDescription) {
        diffs.push({ field: `${spec.name}.description`, expected: spec.description, actual: liveDescription, severity: 'warning' })
      }

      const liveSettings = (full.expeditedUpdateSettings ?? {}) as { qualityUpdateRelease?: string; daysUntilForcedReboot?: number }
      const liveRelease = typeof liveSettings.qualityUpdateRelease === 'string' ? liveSettings.qualityUpdateRelease : ''
      if (spec.qualityUpdateRelease !== liveRelease) {
        diffs.push({ field: `${spec.name}.qualityUpdateRelease`, expected: spec.qualityUpdateRelease, actual: liveRelease, severity: 'warning' })
      }

      if (spec.daysUntilForcedReboot !== undefined) {
        const liveDays = liveSettings.daysUntilForcedReboot
        if (spec.daysUntilForcedReboot !== liveDays) {
          diffs.push({ field: `${spec.name}.daysUntilForcedReboot`, expected: spec.daysUntilForcedReboot, actual: liveDays ?? null, severity: 'warning' })
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
