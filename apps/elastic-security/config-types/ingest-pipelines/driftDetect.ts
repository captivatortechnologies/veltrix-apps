import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient } from '../../lib/elastic'
import { attachDriftActor, veltrixActorLogins } from '../lib/elasticAudit'
import { getIngestPipeline } from './deploy'
import { extractPipelineSpecs, parseJsonArray, parseJsonObject } from './validate'

/**
 * Detect drift between the deployed pipeline configuration and the live
 * cluster state. Re-reads each declared pipeline and diffs the authored
 * fields (description, processors, on_failure, version, _meta) by deep
 * equality. A missing pipeline is critical drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildElasticClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const excludeActorLogins = veltrixActorLogins(ctx.credential)
  const specs = extractPipelineSpecs(ctx.deployedConfig).filter((s) => s.id && s.processorsJson)

  for (const spec of specs) {
    try {
      const live = await getIngestPipeline(client, spec.id)

      if (!live) {
        diffs.push({ field: spec.id, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const before = diffs.length

      const liveDescription = live.description ?? ''
      if ((spec.description ?? '') !== liveDescription) {
        diffs.push({
          field: `${spec.id}.description`,
          expected: spec.description ?? 'not set',
          actual: liveDescription || 'not set',
          severity: 'info',
        })
      }

      const authoredProcessors = spec.processorsJson ? (parseJsonArray(spec.processorsJson) ?? []) : []
      if (stableStringify(authoredProcessors) !== stableStringify(live.processors ?? [])) {
        diffs.push({
          field: `${spec.id}.processors`,
          expected: stableStringify(authoredProcessors),
          actual: stableStringify(live.processors ?? []),
          severity: 'critical',
        })
      }

      const authoredOnFailure = spec.onFailureJson ? (parseJsonArray(spec.onFailureJson) ?? []) : []
      if (stableStringify(authoredOnFailure) !== stableStringify(live.on_failure ?? [])) {
        diffs.push({
          field: `${spec.id}.on_failure`,
          expected: stableStringify(authoredOnFailure),
          actual: stableStringify(live.on_failure ?? []),
          severity: 'warning',
        })
      }

      if (spec.version !== undefined && spec.version !== live.version) {
        diffs.push({
          field: `${spec.id}.version`,
          expected: spec.version,
          actual: live.version ?? 'not set',
          severity: 'info',
        })
      }

      const authoredMeta = spec.metaJson ? (parseJsonObject(spec.metaJson) ?? {}) : {}
      if (stableStringify(authoredMeta) !== stableStringify(live._meta ?? {})) {
        diffs.push({
          field: `${spec.id}._meta`,
          expected: stableStringify(authoredMeta),
          actual: stableStringify(live._meta ?? {}),
          severity: 'info',
        })
      }

      // An Elasticsearch ingest pipeline carries no modifier field and no
      // per-object audit trail via this API, so this resolves to no actor
      // ("—"). Wired uniformly so it attributes automatically if ES ever
      // records a modifier — best-effort, never fabricated.
      attachDriftActor(diffs.slice(before), live, { excludeActorLogins })
    } catch (error) {
      diffs.push({
        field: spec.id,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

/** Deterministic JSON stringify with recursively sorted object keys. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}
