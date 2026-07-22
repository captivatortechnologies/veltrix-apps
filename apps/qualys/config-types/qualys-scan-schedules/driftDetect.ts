import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildQualysClient } from '../../lib/qualys'
import { attachDriftActor, veltrixActorLogins } from '../lib/qualysActivityLog'
import { listSchedules } from './deploy'
import { extractScheduleSpecs, scheduleKey, type LiveSchedule } from './validate'

/**
 * Detect drift between the deployed scan schedule configuration and the live
 * platform. Re-finds each declared schedule by scan title and diffs the fields
 * the list API exposes (active flag, option profile). A missing schedule is
 * critical drift. (Recurrence timing is not returned in a comparable form, so it
 * is not diffed here.)
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildQualysClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractScheduleSpecs(ctx.deployedConfig).filter((s) => s.scanTitle)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  // Connection identity our own deploys appear under — excluded so attribution
  // reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = await listSchedules(client)
    const byKey = new Map<string, LiveSchedule>(live.map((s) => [scheduleKey({ scanTitle: s.title }), s]))

    for (const spec of specs) {
      const before = diffs.length
      const found = byKey.get(scheduleKey(spec))
      if (!found) {
        diffs.push({ field: spec.scanTitle, expected: 'exists', actual: 'missing', severity: 'critical' })
        // Deleted/absent — no live id; attribute by name (best-effort).
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.scanTitle, excludeActorLogins })
        continue
      }
      if (found.active !== spec.active) {
        diffs.push({
          field: `${spec.scanTitle}.active`,
          expected: String(spec.active),
          actual: String(found.active),
          severity: 'warning',
        })
      }
      if (spec.optionTitle && found.optionProfileTitle && found.optionProfileTitle !== spec.optionTitle) {
        diffs.push({
          field: `${spec.scanTitle}.option_profile`,
          expected: spec.optionTitle,
          actual: found.optionProfileTitle,
          severity: 'warning',
        })
      }

      // Attribute every diff this schedule produced to the last human change (once).
      await attachDriftActor(client, diffs.slice(before), {
        targetId: found.id,
        targetName: spec.scanTitle,
        excludeActorLogins,
      })
    }
  } catch (error) {
    diffs.push({
      field: 'qualys',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
