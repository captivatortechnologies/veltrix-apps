import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildTenableClient } from '../../lib/tenable'
import { attachDriftActor, veltrixActorLogins } from '../lib/tenableAudit'
import { findExclusion } from './deploy'
import { extractExclusionSpecs, type ExclusionSpec, type LiveExclusion } from './validate'

/**
 * Detect drift between the deployed exclusion configuration and the live tenant
 * state. Looks up each declared exclusion by name and diffs the managed fields
 * (members + the normalized schedule). A disabled exclusion collapses the
 * schedule shape, so enabled state is compared before any window fields.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractExclusionSpecs(ctx.deployedConfig).filter((s) => s.name)
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  for (const spec of specs) {
    const before = diffs.length
    try {
      const live = await findExclusion(client, spec.name)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.name, excludeActorLogins })
        continue
      }

      // members decides which assets are shielded from scanning — order is not
      // significant, so normalize before comparing.
      const desiredMembers = normalizeMembers(spec.members)
      const liveMembers = normalizeMembers(live.members ?? '')
      if (desiredMembers !== liveMembers) {
        diffs.push({
          field: `${spec.name}.members`,
          expected: desiredMembers || 'none',
          actual: liveMembers || 'none',
          severity: 'warning',
        })
      }

      diffSchedule(diffs, spec, live)

      const liveDescription = (live.description ?? '').trim()
      if ((spec.description ?? '') !== liveDescription) {
        diffs.push({
          field: `${spec.name}.description`,
          expected: spec.description ?? 'not set',
          actual: liveDescription || 'not set',
          severity: 'info',
        })
      }

      // Attribute every diff this exclusion produced to the last change (once).
      await attachDriftActor(client, diffs.slice(before), {
        targetId: live.id,
        targetName: spec.name,
        excludeActorLogins,
      })
    } catch (error) {
      diffs.push({
        field: spec.name,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

/** Compare the desired vs live schedule, honoring the disabled-collapse shape. */
function diffSchedule(diffs: DriftDiff[], spec: ExclusionSpec, live: LiveExclusion): void {
  const liveEnabled = live.schedule?.enabled ?? false

  if (spec.enabled !== liveEnabled) {
    diffs.push({
      field: `${spec.name}.schedule.enabled`,
      expected: spec.enabled,
      actual: liveEnabled,
      severity: 'warning',
    })
    // When the enabled flag itself drifts the window fields are not comparable.
    return
  }

  // Both disabled ("Always On") — nothing further to compare.
  if (!spec.enabled) return

  const schedule = live.schedule ?? {}
  compare(diffs, `${spec.name}.schedule.starttime`, spec.starttime ?? '', (schedule.starttime ?? '').trim())
  compare(diffs, `${spec.name}.schedule.endtime`, spec.endtime ?? '', (schedule.endtime ?? '').trim())
  compare(
    diffs,
    `${spec.name}.schedule.timezone`,
    spec.timezone ?? 'Etc/UTC',
    (schedule.timezone ?? '').trim() || 'Etc/UTC',
  )

  const rrules = schedule.rrules ?? {}
  compare(diffs, `${spec.name}.schedule.freq`, spec.freq ?? 'ONETIME', (rrules.freq ?? 'ONETIME').toUpperCase())
  compare(diffs, `${spec.name}.schedule.interval`, spec.interval ?? 1, rrules.interval ?? 1)

  // byweekday only meaningful for WEEKLY; bymonthday only for MONTHLY.
  const desiredFreq = spec.freq ?? 'ONETIME'
  if (desiredFreq === 'WEEKLY') {
    const desiredDays = normalizeWeekdaySet(spec.byweekday ?? '')
    const liveDays = normalizeWeekdaySet(rrules.byweekday ?? '')
    compare(diffs, `${spec.name}.schedule.byweekday`, desiredDays || 'none', liveDays || 'none')
  }
  if (desiredFreq === 'MONTHLY' && spec.bymonthday !== undefined) {
    compare(diffs, `${spec.name}.schedule.bymonthday`, spec.bymonthday, rrules.bymonthday ?? 'not set')
  }
}

function compare(diffs: DriftDiff[], field: string, expected: unknown, actual: unknown): void {
  if (expected !== actual) {
    diffs.push({ field, expected, actual, severity: 'warning' })
  }
}

/** Normalize a members string to a comparable, order-independent form. */
function normalizeMembers(value: string): string {
  return value
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean)
    .sort()
    .join(',')
}

/** Normalize a byweekday string to a comparable, order-independent form. */
function normalizeWeekdaySet(value: string): string {
  return value
    .split(',')
    .map((d) => d.trim().toUpperCase())
    .filter(Boolean)
    .sort()
    .join(',')
}
