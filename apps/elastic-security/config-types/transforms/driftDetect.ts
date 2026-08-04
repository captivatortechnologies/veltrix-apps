import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient } from '../../lib/elastic'
import { getTransform, getTransformState } from './deploy'
import { extractTransformSpecs, parseJsonObject, pickMutableKeys, stripMutableKeys } from './validate'

/**
 * Detect drift between the deployed transform configuration and the live
 * cluster state. Re-reads each declared transform and diffs:
 *   - description / source / dest — deep equality
 *   - the MUTABLE definition keys (sync/frequency/settings/retention_policy)
 *   - the IMMUTABLE pivot/latest aggregation — reported as drift (an
 *     unfixable one, since Elasticsearch has no API to change it in place;
 *     the only remedy is delete + recreate) if the canvas was edited after
 *     the transform was created
 *   - the running state vs the "Enabled" toggle
 *
 * Elasticsearch transforms carry no modifier field and no per-object audit
 * trail via this API, so drift here is reported without an actor ("—") —
 * unattributed by design, consistent with ILM / role-mappings / roles.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildElasticClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractTransformSpecs(ctx.deployedConfig).filter((s) => s.transformId && s.definitionJson)

  for (const spec of specs) {
    const label = spec.transformId
    try {
      const live = await getTransform(client, spec.transformId)
      if (!live) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const liveDescription = live.description ?? ''
      if ((spec.description ?? '') !== liveDescription) {
        diffs.push({
          field: `${label}.description`,
          expected: spec.description ?? 'not set',
          actual: liveDescription || 'not set',
          severity: 'info',
        })
      }

      if (!sameSet(spec.sourceIndex, live.source?.index ?? [])) {
        diffs.push({
          field: `${label}.source.index`,
          expected: spec.sourceIndex.join(', '),
          actual: (live.source?.index ?? []).join(', ') || 'not set',
          severity: 'critical',
        })
      }

      if (spec.destIndex !== live.dest?.index) {
        diffs.push({
          field: `${label}.dest.index`,
          expected: spec.destIndex,
          actual: live.dest?.index ?? 'not set',
          severity: 'critical',
        })
      }

      const definition = spec.definitionJson ? (parseJsonObject(spec.definitionJson) ?? {}) : {}
      const liveMutable = { sync: live.sync, frequency: live.frequency, settings: live.settings, retention_policy: live.retention_policy }
      const authoredMutable = pickMutableKeys(definition)
      if (stableStringify(authoredMutable) !== stableStringify(stripUndefined(liveMutable))) {
        diffs.push({
          field: `${label}.definition.mutable`,
          expected: stableStringify(authoredMutable),
          actual: stableStringify(stripUndefined(liveMutable)),
          severity: 'warning',
        })
      }

      // pivot/latest is IMMUTABLE — Elasticsearch has no API to change it in
      // place, so a mismatch here can only be corrected by deleting and
      // recreating the transform. Still reported (never silently ignored).
      const authoredImmutable = stripMutableKeys(definition)
      const liveImmutable = stripUndefined({ pivot: live.pivot, latest: live.latest })
      if (stableStringify(authoredImmutable) !== stableStringify(liveImmutable)) {
        diffs.push({
          field: `${label}.definition.aggregation`,
          expected: stableStringify(authoredImmutable),
          actual: stableStringify(liveImmutable),
          severity: 'critical',
        })
      }

      const state = await getTransformState(client, spec.transformId)
      const running = state === 'started' || state === 'indexing'
      if (spec.enabled !== running) {
        diffs.push({
          field: `${label}.enabled`,
          expected: spec.enabled,
          actual: running,
          severity: 'warning',
        })
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

/** Drop keys whose value is undefined so an absent live field compares equal to an unauthored one. */
function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v
  }
  return out
}

/** Deterministic JSON stringify with recursively sorted object keys. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}
