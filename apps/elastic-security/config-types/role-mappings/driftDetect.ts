import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient } from '../../lib/elastic'
import { getRoleMapping } from './deploy'
import { extractMappingSpecs, parseJsonObject } from './validate'

/**
 * Detect drift between the deployed role-mapping configuration and the live
 * cluster state. Re-reads each declared mapping (GET returns
 * `{ "<name>": { enabled, roles, rules, metadata } }`) and diffs the authored
 * fields:
 *   - enabled  — boolean equality
 *   - roles    — order-insensitive SET equality (a mapping grants a set of roles)
 *   - rules    — deep equality of the DSL (Elasticsearch stores it verbatim)
 *   - metadata — deep equality, EXCLUDING keys starting with `_` (those are
 *                Elasticsearch-owned, e.g. `_reserved`, and are never authored)
 * A missing mapping is critical drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildElasticClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractMappingSpecs(ctx.deployedConfig).filter((s) => s.name && s.rulesJson)

  for (const spec of specs) {
    try {
      const live = await getRoleMapping(client, spec.name)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      // enabled — a disabled mapping grants nothing.
      const liveEnabled = live.enabled === true
      if (spec.enabled !== liveEnabled) {
        diffs.push({
          field: `${spec.name}.enabled`,
          expected: spec.enabled,
          actual: liveEnabled,
          severity: 'warning',
        })
      }

      // roles — the granted set; order does not matter.
      const liveRoles = Array.isArray(live.roles) ? live.roles.map(String) : []
      if (!sameSet(spec.roles, liveRoles)) {
        diffs.push({
          field: `${spec.name}.roles`,
          expected: spec.roles.join(', ') || 'none',
          actual: liveRoles.join(', ') || 'none',
          severity: 'critical',
        })
      }

      // rules — the DSL that decides who matches; Elasticsearch stores it verbatim.
      const authoredRules = spec.rulesJson ? parseJsonObject(spec.rulesJson) : null
      if (authoredRules) {
        const liveRules = live.rules ?? {}
        if (stableStringify(authoredRules) !== stableStringify(liveRules)) {
          diffs.push({
            field: `${spec.name}.rules`,
            expected: stableStringify(authoredRules),
            actual: stableStringify(liveRules),
            severity: 'critical',
          })
        }
      }

      // metadata — compare only author-owned keys; strip `_`-prefixed keys from
      // both sides so Elasticsearch-managed keys (e.g. _reserved) never read as drift.
      const authoredMeta = spec.metadataJson ? parseJsonObject(spec.metadataJson) ?? {} : {}
      const expectedMeta = stripUnderscoreKeys(authoredMeta)
      const actualMeta = stripUnderscoreKeys(live.metadata)
      if (stableStringify(expectedMeta) !== stableStringify(actualMeta)) {
        diffs.push({
          field: `${spec.name}.metadata`,
          expected: stableStringify(expectedMeta),
          actual: stableStringify(actualMeta),
          severity: 'info',
        })
      }
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

/** Order-insensitive equality of two string lists. */
export function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const bSet = new Set(b)
  return a.every((item) => bSet.has(item))
}

/** Return a copy of an object with every `_`-prefixed (reserved) key removed. */
export function stripUnderscoreKeys(obj: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj ?? {})) {
    if (!key.startsWith('_')) out[key] = value
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
