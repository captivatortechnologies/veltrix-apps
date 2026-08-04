import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient } from '../../lib/elastic'
import { attachDriftActor, veltrixActorLogins } from '../lib/elasticAudit'
import { getComponentTemplate } from './deploy'
import { extractTemplateSpecs, parseJsonObject } from './validate'

/**
 * Detect drift between the deployed component-template configuration and the
 * live cluster state. Re-reads each declared template and diffs the "template"
 * body by deep equality, plus version / deprecated / _meta. A missing template
 * is critical drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildElasticClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const excludeActorLogins = veltrixActorLogins(ctx.credential)
  const specs = extractTemplateSpecs(ctx.deployedConfig).filter((s) => s.name && s.templateJson)

  for (const spec of specs) {
    try {
      const live = await getComponentTemplate(client, spec.name)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const before = diffs.length
      const liveTemplate = live.component_template ?? {}

      const authoredTemplate = spec.templateJson ? (parseJsonObject(spec.templateJson) ?? {}) : {}
      if (stableStringify(authoredTemplate) !== stableStringify(liveTemplate.template ?? {})) {
        diffs.push({
          field: `${spec.name}.template`,
          expected: stableStringify(authoredTemplate),
          actual: stableStringify(liveTemplate.template ?? {}),
          severity: 'warning',
        })
      }

      if (spec.version !== undefined && spec.version !== liveTemplate.version) {
        diffs.push({
          field: `${spec.name}.version`,
          expected: spec.version,
          actual: liveTemplate.version ?? 'not set',
          severity: 'info',
        })
      }

      const liveDeprecated = liveTemplate.deprecated === true
      if (spec.deprecated !== liveDeprecated) {
        diffs.push({
          field: `${spec.name}.deprecated`,
          expected: spec.deprecated,
          actual: liveDeprecated,
          severity: 'info',
        })
      }

      const authoredMeta = spec.metaJson ? (parseJsonObject(spec.metaJson) ?? {}) : {}
      if (stableStringify(authoredMeta) !== stableStringify(liveTemplate._meta ?? {})) {
        diffs.push({
          field: `${spec.name}._meta`,
          expected: stableStringify(authoredMeta),
          actual: stableStringify(liveTemplate._meta ?? {}),
          severity: 'info',
        })
      }

      // A component template carries no modifier field and no per-object audit
      // trail via this API, so this resolves to no actor ("—"). Wired uniformly
      // so it attributes automatically if ES ever records a modifier —
      // best-effort, never fabricated.
      attachDriftActor(diffs.slice(before), live, { excludeActorLogins })
    } catch (error) {
      diffs.push({
        field: spec.name,
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
