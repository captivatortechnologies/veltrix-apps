import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildTenableClient } from '../../lib/tenable'
import { attachDriftActor, veltrixActorLogins } from '../lib/tenableAudit'
import { findScan, getScanSettings } from './deploy'
import { assembleRrules, extractScanSpecs } from './validate'

/**
 * Detect drift between the deployed scan configuration and the live tenant
 * state. Looks up each declared scan by name, reads its detail, and diffs the
 * managed fields — targets and the schedule (the recurrence rrules STRING is
 * normalized so an equivalent expression is not reported as drift).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractScanSpecs(ctx.deployedConfig).filter((s) => s.name)
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  for (const spec of specs) {
    const before = diffs.length
    try {
      const live = await findScan(client, spec.name)

      if (!live || live.id === undefined) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.name, excludeActorLogins })
        continue
      }

      const settings = (await getScanSettings(client, live.id)) ?? {}

      // Targets decide what the scan runs against — a mismatch is significant.
      const liveTargets = normalizeTargets(settings.text_targets)
      if (liveTargets !== spec.textTargets) {
        diffs.push({
          field: `${spec.name}.textTargets`,
          expected: spec.textTargets,
          actual: liveTargets || 'not set',
          severity: 'critical',
        })
      }

      // Schedule: compare the launch cadence and the normalized recurrence.
      const liveLaunch = typeof settings.launch === 'string' ? settings.launch.toUpperCase() : ''
      if (liveLaunch !== spec.launch) {
        diffs.push({
          field: `${spec.name}.launch`,
          expected: spec.launch,
          actual: liveLaunch || 'not set',
          severity: 'warning',
        })
      }

      const desiredRrules = normalizeRrules(assembleRrules(spec.launch, spec.interval ?? 1, spec.byday))
      const liveRrules = normalizeRrules(typeof settings.rrules === 'string' ? settings.rrules : undefined)
      if (desiredRrules !== liveRrules) {
        diffs.push({
          field: `${spec.name}.rrules`,
          expected: desiredRrules || 'not set',
          actual: liveRrules || 'not set',
          severity: 'warning',
        })
      }

      // A scheduled scan's start time only matters when there is a cadence.
      if (spec.launch !== 'ON_DEMAND' && spec.starttime) {
        const liveStart = typeof settings.starttime === 'string' ? settings.starttime.trim() : ''
        if (liveStart !== spec.starttime) {
          diffs.push({
            field: `${spec.name}.starttime`,
            expected: spec.starttime,
            actual: liveStart || 'not set',
            severity: 'warning',
          })
        }
      }

      const liveName = typeof settings.name === 'string' ? settings.name : live.name ?? ''
      if (liveName !== spec.name) {
        diffs.push({
          field: `${spec.name}.name`,
          expected: spec.name,
          actual: liveName || 'not set',
          severity: 'info',
        })
      }

      // Attribute every diff this scan produced to the last change (once).
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

// --- Helpers ---

/** Normalize a live text_targets string to the same comma-joined shape specs use. */
function normalizeTargets(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.split(/[\n,]/).map((p) => p.trim()).filter(Boolean).join(',')
}

/**
 * Normalize an rrules STRING for comparison: upper-case, sort the term list and
 * sort BYDAY days, so `FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE,FR` and
 * `INTERVAL=1;FREQ=WEEKLY;BYDAY=FR,MO,WE` compare equal.
 */
function normalizeRrules(rrules: string | undefined): string {
  if (!rrules) return ''
  return rrules
    .toUpperCase()
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [key, val] = part.split('=')
      if (key === 'BYDAY' && val) {
        const days = val.split(',').map((d) => d.trim()).filter(Boolean).sort()
        return `BYDAY=${days.join(',')}`
      }
      return `${key}=${val ?? ''}`
    })
    .sort()
    .join(';')
}
