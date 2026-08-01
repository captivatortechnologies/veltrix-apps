import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildPagerDutyClient } from '../../lib/pagerdutyApi'
import { extractScheduleSpecs, findSchedule, parseScheduleLayers } from './_shared'
import { listSchedules } from './deploy'

/**
 * Detect drift between the deployed schedules configuration and the live PagerDuty
 * account. Re-finds each declared schedule by its `name`:
 *   - a missing schedule is CRITICAL drift
 *   - a changed time_zone is WARNING drift
 *   - a changed number of rotation layers is INFO drift
 *
 * We report presence + these two STABLE scalars and intentionally do NOT deep-diff
 * the layer/user arrays: PagerDuty expands each layer with rendered_schedule_entries,
 * coverage percentages and full user APIObjects whose server-normalized shape never
 * matches the compact layers a user typed, so a structural diff would flag constant
 * false drift. Best-effort — an unreadable account raises no false drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildPagerDutyClient(ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractScheduleSpecs(ctx.deployedConfig).filter((s) => s.name && s.timeZone && s.layersJson.trim())
  if (specs.length === 0) return { hasDrift: false, diffs }

  let live
  try {
    live = await listSchedules(client)
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read schedules, no drift asserted
  }

  for (const spec of specs) {
    const match = findSchedule(live, spec.name)
    if (!match) {
      diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    if (spec.timeZone && match.time_zone && match.time_zone !== spec.timeZone) {
      diffs.push({ field: `${spec.name}.time_zone`, expected: spec.timeZone, actual: match.time_zone, severity: 'warning' })
    }

    const expectedLayers = parseScheduleLayers(spec.layersJson).layers
    const actualCount = Array.isArray(match.schedule_layers) ? match.schedule_layers.length : 0
    if (expectedLayers && expectedLayers.length !== actualCount) {
      diffs.push({
        field: `${spec.name}.schedule_layers`,
        expected: `${expectedLayers.length} layer(s)`,
        actual: `${actualCount} layer(s)`,
        severity: 'info',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
