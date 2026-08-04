import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildDatadogClient } from '../../lib/datadogApi'
import { getLogMetric } from './deploy'
import { extractLogMetricSpecs, parseJsonArray } from './_shared'

/**
 * Detect drift between the deployed Log-Based Metric configuration and the
 * live organization. Direct GET by id per declared metric (its own
 * identity). Diffs filter.query, group_by and (for distribution metrics)
 * include_percentiles. aggregation_type/path are create-only and are not
 * expected to drift (Datadog does not allow changing them).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const built = buildDatadogClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractLogMetricSpecs(ctx.deployedConfig).filter((s) => s.id)
  const diffs: DriftDiff[] = []

  for (const spec of specs) {
    const label = spec.id
    let live
    try {
      live = await getLogMetric(client, spec.id)
    } catch (error) {
      diffs.push({ field: label, expected: 'readable', actual: `unreadable: ${error instanceof Error ? error.message : 'unknown'}`, severity: 'warning' })
      continue
    }
    if (!live) {
      diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }
    const attrs = live.attributes ?? {}

    if (spec.filterQuery !== (attrs.filter?.query ?? '')) {
      diffs.push({ field: `${label}.filter_query`, expected: spec.filterQuery, actual: attrs.filter?.query ?? 'not set', severity: 'warning' })
    }
    if (spec.aggregationType === 'distribution') {
      const liveIncludePercentiles = attrs.compute?.include_percentiles ?? false
      if (spec.includePercentiles !== liveIncludePercentiles) {
        diffs.push({
          field: `${label}.include_percentiles`,
          expected: spec.includePercentiles,
          actual: liveIncludePercentiles,
          severity: 'warning',
        })
      }
    }

    const groupBy = parseJsonArray(spec.groupByRaw)
    const declaredGroupBy = groupBy.ok ? (groupBy.value ?? []) : []
    const liveGroupBy = Array.isArray(attrs.group_by) ? attrs.group_by : []
    if (JSON.stringify(declaredGroupBy) !== JSON.stringify(liveGroupBy)) {
      diffs.push({ field: `${label}.group_by`, expected: JSON.stringify(declaredGroupBy), actual: JSON.stringify(liveGroupBy), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
