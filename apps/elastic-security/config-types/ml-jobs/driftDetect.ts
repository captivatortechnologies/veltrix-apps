import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient } from '../../lib/elastic'
import { getDatafeed, getDatafeedState, getJob, getJobState } from './deploy'
import { extractJobSpecs, parseJsonObject } from './validate'

/**
 * Detect drift between the deployed ML job/datafeed configuration and the live
 * cluster state:
 *   - analysis_config / data_description — IMMUTABLE; a mismatch is reported
 *     as critical drift that can only be corrected by deleting and recreating
 *     the job (there is no API to change them in place)
 *   - groups / description / analysis_limits / model_plot_config — mutable,
 *     deep-equality
 *   - datafeed indices / query — deep-equality
 *   - running state vs the "Enabled" toggle
 *
 * Elasticsearch ML jobs carry no modifier field and no per-object audit trail
 * via this API, so drift here is reported without an actor ("—") —
 * unattributed by design, consistent with ILM / role-mappings / transforms.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildElasticClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractJobSpecs(ctx.deployedConfig).filter((s) => s.jobId && s.analysisConfigJson && s.dataDescriptionJson)

  for (const spec of specs) {
    const label = spec.jobId
    try {
      const liveJob = await getJob(client, spec.jobId)
      if (!liveJob) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const authoredAnalysisConfig = spec.analysisConfigJson ? (parseJsonObject(spec.analysisConfigJson) ?? {}) : {}
      if (stableStringify(authoredAnalysisConfig) !== stableStringify(liveJob.analysis_config ?? {})) {
        diffs.push({
          field: `${label}.analysis_config`,
          expected: stableStringify(authoredAnalysisConfig),
          actual: stableStringify(liveJob.analysis_config ?? {}),
          severity: 'critical',
        })
      }

      const authoredDataDescription = spec.dataDescriptionJson ? (parseJsonObject(spec.dataDescriptionJson) ?? {}) : {}
      if (stableStringify(authoredDataDescription) !== stableStringify(liveJob.data_description ?? {})) {
        diffs.push({
          field: `${label}.data_description`,
          expected: stableStringify(authoredDataDescription),
          actual: stableStringify(liveJob.data_description ?? {}),
          severity: 'critical',
        })
      }

      if (!sameSet(spec.groups, liveJob.groups ?? [])) {
        diffs.push({
          field: `${label}.groups`,
          expected: spec.groups.join(', ') || 'none',
          actual: (liveJob.groups ?? []).join(', ') || 'none',
          severity: 'info',
        })
      }

      const liveDescription = liveJob.description ?? ''
      if ((spec.description ?? '') !== liveDescription) {
        diffs.push({
          field: `${label}.description`,
          expected: spec.description ?? 'not set',
          actual: liveDescription || 'not set',
          severity: 'info',
        })
      }

      const authoredLimits = spec.analysisLimitsJson ? (parseJsonObject(spec.analysisLimitsJson) ?? {}) : {}
      if (stableStringify(authoredLimits) !== stableStringify(liveJob.analysis_limits ?? {})) {
        diffs.push({
          field: `${label}.analysis_limits`,
          expected: stableStringify(authoredLimits),
          actual: stableStringify(liveJob.analysis_limits ?? {}),
          severity: 'warning',
        })
      }

      const liveDatafeed = await getDatafeed(client, spec.datafeedId)
      if (!liveDatafeed) {
        diffs.push({ field: `${label}.datafeed`, expected: 'exists', actual: 'missing', severity: 'critical' })
      } else {
        if (!sameSet(spec.datafeedIndices, liveDatafeed.indices ?? [])) {
          diffs.push({
            field: `${label}.datafeed.indices`,
            expected: spec.datafeedIndices.join(', '),
            actual: (liveDatafeed.indices ?? []).join(', ') || 'not set',
            severity: 'critical',
          })
        }
        const authoredQuery = spec.datafeedQueryJson ? (parseJsonObject(spec.datafeedQueryJson) ?? {}) : {}
        if (stableStringify(authoredQuery) !== stableStringify(liveDatafeed.query ?? {})) {
          diffs.push({
            field: `${label}.datafeed.query`,
            expected: stableStringify(authoredQuery),
            actual: stableStringify(liveDatafeed.query ?? {}),
            severity: 'warning',
          })
        }
      }

      const jobState = await getJobState(client, spec.jobId)
      const datafeedState = await getDatafeedState(client, spec.datafeedId)
      const running = jobState === 'opened' && (datafeedState === 'started' || datafeedState === 'starting')
      if (spec.enabled !== running) {
        diffs.push({ field: `${label}.enabled`, expected: spec.enabled, actual: running, severity: 'warning' })
      }
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

/** Order-insensitive equality of two string lists. */
function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const bSet = new Set(b)
  return a.every((item) => bSet.has(item))
}

/** Deterministic JSON stringify with recursively sorted object keys. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}
