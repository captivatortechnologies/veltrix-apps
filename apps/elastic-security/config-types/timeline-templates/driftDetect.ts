import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient } from '../../lib/elastic'
import { attachDriftActor, veltrixActorLogins } from '../lib/elasticAudit'
import { getTimelineTemplate } from './deploy'
import { definitionOf, extractTemplateSpecs, parseJsonObject } from './validate'

/**
 * Detect drift between the deployed timeline-template configuration and the
 * live Kibana state. Re-fetches each declared template by its
 * `templateTimelineId` and diffs title / description / the folded-in
 * definition. A missing template is critical drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildElasticClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const excludeActorLogins = veltrixActorLogins(ctx.credential)
  const specs = extractTemplateSpecs(ctx.deployedConfig).filter((s) => s.templateTimelineId && s.title)

  for (const spec of specs) {
    const label = spec.templateTimelineId
    try {
      const live = await getTimelineTemplate(client, spec.templateTimelineId)
      if (!live) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const before = diffs.length

      const liveTitle = live.title ?? ''
      if (spec.title !== liveTitle) {
        diffs.push({ field: `${label}.title`, expected: spec.title, actual: liveTitle || 'not set', severity: 'warning' })
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

      const authoredDefinition = spec.definitionJson ? (parseJsonObject(spec.definitionJson) ?? {}) : {}
      const liveDefinition = definitionOf(live)
      if (!isDeepSubset(authoredDefinition, liveDefinition)) {
        diffs.push({
          field: `${label}.definition`,
          expected: stableStringify(authoredDefinition),
          actual: stableStringify(liveDefinition),
          severity: 'warning',
        })
      }

      // Kibana's Timeline saved object carries createdBy/updatedBy (camelCase,
      // unlike the snake_case detection-rules/exception-lists convention), so
      // adapt it into the shared audit helper's expected shape.
      attachDriftActor(
        diffs.slice(before),
        {
          updated_by: live.updatedBy,
          updated_at: live.updated != null ? String(live.updated) : undefined,
          created_by: live.createdBy,
          created_at: live.created != null ? String(live.created) : undefined,
        },
        { excludeActorLogins },
      )
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

/**
 * Deep-subset check: every key/value in `authored` must appear, equal, in
 * `live`. Used because Kibana echoes back extra normalized fields (ids on
 * dataProviders/columns, etc.) that were never authored — extra live keys are
 * not drift.
 */
function isDeepSubset(authored: unknown, live: unknown): boolean {
  if (authored === null || typeof authored !== 'object') return authored === live
  if (Array.isArray(authored)) {
    if (!Array.isArray(live) || live.length !== authored.length) return false
    return authored.every((v, i) => isDeepSubset(v, (live as unknown[])[i]))
  }
  if (live === null || typeof live !== 'object' || Array.isArray(live)) return false
  const liveObj = live as Record<string, unknown>
  return Object.entries(authored as Record<string, unknown>).every(
    ([key, value]) => key in liveObj && isDeepSubset(value, liveObj[key]),
  )
}

/** Deterministic JSON stringify with recursively sorted object keys. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}
