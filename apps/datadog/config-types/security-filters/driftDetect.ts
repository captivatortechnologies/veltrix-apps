import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildDatadogClient } from '../../lib/datadogApi'
import { listSecurityFilters, readSecurityFilter } from './deploy'
import { extractSecurityFilterSpecs, findSecurityFilterByName, parseJsonArray, type SecurityFilterResource } from './_shared'

/**
 * Detect drift between the deployed Security Filter configuration and the
 * live organization: query / is_enabled / filtered_data_type /
 * exclusion_filters (array length + each declared key).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const built = buildDatadogClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractSecurityFilterSpecs(ctx.deployedConfig).filter((s) => s.name && s.query)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  let live: SecurityFilterResource[]
  try {
    live = await listSecurityFilters(client)
  } catch (error) {
    return {
      hasDrift: true,
      diffs: [{ field: 'datadog', expected: 'reachable', actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`, severity: 'critical' }],
    }
  }

  const diffs: DriftDiff[] = []

  for (const spec of specs) {
    const label = spec.name
    const found = findSecurityFilterByName(live, spec.name)
    if (!found || !found.id) {
      diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    let full: SecurityFilterResource
    try {
      full = await readSecurityFilter(client, found.id)
    } catch (error) {
      diffs.push({ field: label, expected: 'readable', actual: `unreadable: ${error instanceof Error ? error.message : 'unknown'}`, severity: 'warning' })
      continue
    }
    const attrs = full.attributes ?? {}

    if (spec.query !== (attrs.query ?? '')) {
      diffs.push({ field: `${label}.query`, expected: spec.query, actual: attrs.query ?? 'not set', severity: 'warning' })
    }
    const liveEnabled = attrs.is_enabled ?? true
    if (spec.isEnabled !== liveEnabled) {
      diffs.push({ field: `${label}.is_enabled`, expected: spec.isEnabled, actual: liveEnabled, severity: 'warning' })
    }
    const liveType = attrs.filtered_data_type ?? 'logs'
    if (spec.filteredDataType !== liveType) {
      diffs.push({ field: `${label}.filtered_data_type`, expected: spec.filteredDataType, actual: liveType, severity: 'warning' })
    }

    const exclusionFilters = parseJsonArray(spec.exclusionFiltersRaw)
    const liveExclusions = Array.isArray(attrs.exclusion_filters) ? attrs.exclusion_filters : []
    const declaredExclusions = exclusionFilters.ok ? (exclusionFilters.value ?? []) : []
    if (JSON.stringify(declaredExclusions) !== JSON.stringify(liveExclusions)) {
      diffs.push({
        field: `${label}.exclusion_filters`,
        expected: JSON.stringify(declaredExclusions),
        actual: JSON.stringify(liveExclusions),
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
