import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildDatadogClient } from '../../lib/datadogApi'
import { getLogIndex } from './deploy'
import { extractLogIndexSpecs, parseJsonArray, parseOptionalNumber } from './_shared'

/**
 * Detect drift between the deployed Log Index configuration and the live
 * organization. Direct GET by name per declared index (its own identity).
 * Diffs filter.query, num_retention_days, daily_limit, tags and
 * exclusion_filters.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const built = buildDatadogClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractLogIndexSpecs(ctx.deployedConfig).filter((s) => s.name)
  const diffs: DriftDiff[] = []

  for (const spec of specs) {
    const label = spec.name
    let live
    try {
      live = await getLogIndex(client, spec.name)
    } catch (error) {
      diffs.push({ field: label, expected: 'readable', actual: `unreadable: ${error instanceof Error ? error.message : 'unknown'}`, severity: 'warning' })
      continue
    }
    if (!live) {
      diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    if (spec.filterQuery !== (live.filter?.query ?? '')) {
      diffs.push({ field: `${label}.filter_query`, expected: spec.filterQuery, actual: live.filter?.query ?? 'not set', severity: 'warning' })
    }

    const retentionDays = parseOptionalNumber(spec.retentionDaysRaw)
    if (retentionDays !== undefined && !Number.isNaN(retentionDays) && retentionDays !== live.num_retention_days) {
      diffs.push({ field: `${label}.num_retention_days`, expected: retentionDays, actual: live.num_retention_days ?? 'not set', severity: 'warning' })
    }
    const dailyLimit = parseOptionalNumber(spec.dailyLimitRaw)
    if (dailyLimit !== undefined && !Number.isNaN(dailyLimit) && dailyLimit !== live.daily_limit) {
      diffs.push({ field: `${label}.daily_limit`, expected: dailyLimit, actual: live.daily_limit ?? 'not set', severity: 'warning' })
    }

    const liveTags = Array.isArray(live.tags) ? [...live.tags].sort() : []
    const declaredTags = [...spec.tags].sort()
    if (JSON.stringify(declaredTags) !== JSON.stringify(liveTags)) {
      diffs.push({ field: `${label}.tags`, expected: spec.tags, actual: live.tags ?? [], severity: 'warning' })
    }

    const exclusionFilters = parseJsonArray(spec.exclusionFiltersRaw)
    const declared = exclusionFilters.ok ? (exclusionFilters.value ?? []) : []
    const liveExclusions = Array.isArray(live.exclusion_filters) ? live.exclusion_filters : []
    if (JSON.stringify(declared) !== JSON.stringify(liveExclusions)) {
      diffs.push({
        field: `${label}.exclusion_filters`,
        expected: JSON.stringify(declared),
        actual: JSON.stringify(liveExclusions),
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
