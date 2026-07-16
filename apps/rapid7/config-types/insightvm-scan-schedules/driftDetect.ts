import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildInsightVMClient } from '../../lib/insightvm'
import { listSchedules, resolveSiteId } from './deploy'
import { extractScheduleSpecs, type LiveSchedule } from './validate'

/**
 * Detect drift between the deployed scan schedules and the live console. Re-finds
 * each declared schedule by (site, schedule name) and diffs the managed `enabled`
 * flag; a missing schedule is critical drift. The schedule details JSON is not
 * deep-diffed (server-normalized recurrence/scope).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildInsightVMClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractScheduleSpecs(ctx.deployedConfig).filter((s) => s.siteName && s.scheduleName)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  const siteIds = new Map<string, number>()
  const bySite = new Map<number, Map<string, LiveSchedule>>()

  for (const spec of specs) {
    const label = `${spec.scheduleName} @ ${spec.siteName}`
    try {
      const siteId = await resolveSiteId(client, spec.siteName, siteIds)
      let byName = bySite.get(siteId)
      if (!byName) {
        const live = await listSchedules(client, siteId)
        byName = new Map(live.filter((s) => s.scanName).map((s) => [s.scanName as string, s]))
        bySite.set(siteId, byName)
      }
      const found = byName.get(spec.scheduleName)
      if (!found) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      if ((found.enabled ?? true) !== spec.enabled) {
        diffs.push({ field: `${label}.enabled`, expected: String(spec.enabled), actual: String(found.enabled ?? true), severity: 'warning' })
      }
    } catch (error) {
      diffs.push({ field: label, expected: 'reachable', actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`, severity: 'critical' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
