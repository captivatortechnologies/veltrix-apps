import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildDatadogClient } from '../../lib/datadogApi'
import { listSlos, readSlo } from './deploy'
import { extractSloSpecs, findSloByName, parseJsonArray, parseMonitorIds, type DatadogSlo } from './_shared'

/**
 * Detect drift between the deployed SLO configuration and the live
 * organization: description, tags, thresholds, and (by type) the metric
 * query or monitor_ids/groups.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const built = buildDatadogClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractSloSpecs(ctx.deployedConfig).filter((s) => s.name && s.type)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  let live: DatadogSlo[]
  try {
    live = await listSlos(client)
  } catch (error) {
    return {
      hasDrift: true,
      diffs: [{ field: 'datadog', expected: 'reachable', actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`, severity: 'critical' }],
    }
  }

  const diffs: DriftDiff[] = []

  for (const spec of specs) {
    const label = spec.name
    const found = findSloByName(live, spec.name)
    if (!found || !found.id) {
      diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    let full: DatadogSlo
    try {
      full = await readSlo(client, found.id)
    } catch (error) {
      diffs.push({ field: label, expected: 'readable', actual: `unreadable: ${error instanceof Error ? error.message : 'unknown'}`, severity: 'warning' })
      continue
    }

    if (spec.description !== (full.description ?? '')) {
      diffs.push({ field: `${label}.description`, expected: spec.description, actual: full.description ?? 'not set', severity: 'warning' })
    }
    const liveTags = Array.isArray(full.tags) ? [...full.tags].sort() : []
    const declaredTags = [...spec.tags].sort()
    if (JSON.stringify(declaredTags) !== JSON.stringify(liveTags)) {
      diffs.push({ field: `${label}.tags`, expected: spec.tags, actual: full.tags ?? [], severity: 'warning' })
    }

    const thresholds = parseJsonArray(spec.thresholdsRaw)
    const declaredThresholds = thresholds.ok ? (thresholds.value ?? []) : []
    if (JSON.stringify(declaredThresholds) !== JSON.stringify(full.thresholds ?? [])) {
      diffs.push({
        field: `${label}.thresholds`,
        expected: JSON.stringify(declaredThresholds),
        actual: JSON.stringify(full.thresholds ?? []),
        severity: 'warning',
      })
    }

    if (spec.type === 'metric') {
      if (spec.numerator !== (full.query?.numerator ?? '') || spec.denominator !== (full.query?.denominator ?? '')) {
        diffs.push({
          field: `${label}.query`,
          expected: `${spec.numerator} / ${spec.denominator}`,
          actual: `${full.query?.numerator ?? 'not set'} / ${full.query?.denominator ?? 'not set'}`,
          severity: 'warning',
        })
      }
    } else if (spec.type === 'monitor') {
      const monitorIds = parseMonitorIds(spec.monitorIdsRaw)
      const declaredIds = monitorIds.ok ? [...monitorIds.ids].sort() : []
      const liveIds = Array.isArray(full.monitor_ids) ? [...full.monitor_ids].sort() : []
      if (JSON.stringify(declaredIds) !== JSON.stringify(liveIds)) {
        diffs.push({ field: `${label}.monitor_ids`, expected: declaredIds, actual: liveIds, severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
