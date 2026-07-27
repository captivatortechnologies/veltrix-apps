import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, sameSet, splitList } from '../../lib/falcon'
import { attachDriftActor, veltrixActorLogins } from '../lib/crowdstrikeAudit'
import { findScheduledExclusionByName } from './deploy'
import {
  extractScheduledExclusionSpecs,
  type LiveScheduledExclusion,
  type ScheduledExclusionSpec,
} from './validate'

/**
 * Detect drift between the deployed scheduled-exclusion configuration and the
 * live tenant state. Looks up each declared exclusion (by name within its
 * policy) and diffs the schedule window, recurrence, and process/user scope.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  // Connection identity our own deploys are recorded under — excluded so
  // attribution reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  const specs = extractScheduledExclusionSpecs(ctx.deployedConfig).filter((s) => s.name && s.policyId)

  for (const spec of specs) {
    const label = spec.name
    const before = diffs.length
    try {
      const live = await findScheduledExclusionByName(client, spec.policyId, spec.name)

      if (!live) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      diffs.push(...diffScheduledExclusion(spec, live))

      // Attribute every diff this exclusion produced to Falcon's recorded last
      // modifier (once) — no-op when nothing drifted or the change was ours.
      attachDriftActor(diffs.slice(before), live, { excludeActorLogins })
    } catch (error) {
      diffs.push({
        field: label,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

function diffScheduledExclusion(
  spec: ScheduledExclusionSpec,
  live: LiveScheduledExclusion,
): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const label = spec.name

  if (!sameInstant(live.schedule_start, spec.scheduleStart)) {
    diffs.push({
      field: `${label}.scheduleStart`,
      expected: spec.scheduleStart,
      actual: live.schedule_start ?? 'not set',
      severity: 'warning',
    })
  }

  const endMatches =
    spec.scheduleEnd === undefined
      ? !live.schedule_end
      : sameInstant(live.schedule_end, spec.scheduleEnd)
  if (!endMatches) {
    diffs.push({
      field: `${label}.scheduleEnd`,
      expected: spec.scheduleEnd ?? 'open-ended',
      actual: live.schedule_end ?? 'open-ended',
      severity: 'warning',
    })
  }

  if ((live.timezone ?? '') !== spec.timezone) {
    diffs.push({
      field: `${label}.timezone`,
      expected: spec.timezone,
      actual: live.timezone ?? 'not set',
      severity: 'warning',
    })
  }

  const liveRecurrence = live.repeated?.frequency ?? 'never'
  if (liveRecurrence !== spec.recurrence) {
    diffs.push({
      field: `${label}.recurrence`,
      expected: spec.recurrence,
      actual: liveRecurrence,
      severity: 'warning',
    })
  } else if (spec.recurrence === 'weekly') {
    const liveDays = (live.repeated?.weekly_days ?? []).map((d) => String(d).toLowerCase())
    if (!sameSet(liveDays, spec.weeklyDays)) {
      diffs.push({
        field: `${label}.weeklyDays`,
        expected: spec.weeklyDays.join(', ') || 'none',
        actual: liveDays.join(', ') || 'none',
        severity: 'warning',
      })
    }
  } else if (spec.recurrence === 'monthly') {
    const liveDays = (live.repeated?.monthly_days ?? []).map((d) => String(d))
    if (!sameSet(liveDays, spec.monthlyDays)) {
      diffs.push({
        field: `${label}.monthlyDays`,
        expected: spec.monthlyDays.join(', ') || 'none',
        actual: liveDays.join(', ') || 'none',
        severity: 'warning',
      })
    }
  }

  const liveProcesses = splitList(live.processes)
  if (!sameSet(liveProcesses, spec.processes)) {
    diffs.push({
      field: `${label}.processes`,
      expected: spec.processes.join(', ') || 'none',
      actual: liveProcesses.join(', ') || 'none',
      severity: 'warning',
    })
  }

  const liveUsers = splitList(live.users)
  if (!sameSet(liveUsers, spec.users)) {
    diffs.push({
      field: `${label}.users`,
      expected: spec.users.join(', ') || 'none',
      actual: liveUsers.join(', ') || 'none',
      severity: 'warning',
    })
  }

  return diffs
}

/** Compare timestamps by instant, tolerating formatting differences. */
function sameInstant(a: string | undefined, b: string | undefined): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  const parsedA = Date.parse(a)
  const parsedB = Date.parse(b)
  if (Number.isNaN(parsedA) || Number.isNaN(parsedB)) return a === b
  return parsedA === parsedB
}
