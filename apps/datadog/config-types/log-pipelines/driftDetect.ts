import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildDatadogClient } from '../../lib/datadogApi'
import { listPipelines, readPipeline } from './deploy'
import { deepSubsetEqual, extractPipelineSpecs, findPipelineByName, parseJsonArray, stableStringify, type LogPipeline } from './_shared'

/**
 * Detect drift between the deployed Log Pipeline configuration and the live
 * organization. Re-finds each declared pipeline by name and diffs
 * description / is_enabled / filter.query / processors (subset-aware —
 * Datadog may default extra keys into a processor object we did not fully
 * specify).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const built = buildDatadogClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractPipelineSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  let live: LogPipeline[]
  try {
    live = await listPipelines(client)
  } catch (error) {
    return {
      hasDrift: true,
      diffs: [
        {
          field: 'datadog',
          expected: 'reachable',
          actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
          severity: 'critical',
        },
      ],
    }
  }

  const diffs: DriftDiff[] = []

  for (const spec of specs) {
    const label = spec.name
    const found = findPipelineByName(live, spec.name)
    if (!found || !found.id) {
      diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    let full: LogPipeline
    try {
      full = await readPipeline(client, found.id)
    } catch (error) {
      diffs.push({
        field: label,
        expected: 'readable',
        actual: `unreadable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'warning',
      })
      continue
    }

    if (spec.description !== (full.description ?? '')) {
      diffs.push({ field: `${label}.description`, expected: spec.description, actual: full.description ?? 'not set', severity: 'warning' })
    }
    const liveEnabled = full.is_enabled ?? true
    if (spec.isEnabled !== liveEnabled) {
      diffs.push({ field: `${label}.is_enabled`, expected: spec.isEnabled, actual: liveEnabled, severity: 'warning' })
    }
    const liveFilter = full.filter?.query ?? ''
    if (spec.filterQuery !== liveFilter) {
      diffs.push({ field: `${label}.filter_query`, expected: spec.filterQuery, actual: liveFilter, severity: 'warning' })
    }

    const processors = parseJsonArray(spec.processorsRaw)
    if (processors.ok && processors.value !== undefined && !deepSubsetEqual(processors.value, full.processors ?? [])) {
      diffs.push({
        field: `${label}.processors`,
        expected: stableStringify(processors.value),
        actual: stableStringify(full.processors ?? []),
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
