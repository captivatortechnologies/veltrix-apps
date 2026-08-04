import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient } from '../../lib/elastic'
import { attachDriftActor, veltrixActorLogins } from '../lib/elasticAudit'
import { getRole } from './deploy'
import { extractRoleSpecs, parseJsonArray, parseJsonObject } from './validate'

/**
 * Detect drift between the deployed role configuration and the live cluster
 * state. Re-reads each declared role and diffs the authored fields:
 *   - cluster / run_as — order-insensitive SET equality
 *   - indices / applications — deep equality of the declared JSON array
 *   - metadata — deep equality, EXCLUDING keys starting with `_` (those are
 *     Elasticsearch-owned, e.g. `_reserved`, and are never authored)
 * A missing role is critical drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildElasticClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const excludeActorLogins = veltrixActorLogins(ctx.credential)
  const specs = extractRoleSpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    try {
      const live = await getRole(client, spec.name)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const before = diffs.length

      if (!sameSet(spec.cluster, live.cluster ?? [])) {
        diffs.push({
          field: `${spec.name}.cluster`,
          expected: spec.cluster.join(', ') || 'none',
          actual: (live.cluster ?? []).join(', ') || 'none',
          severity: 'critical',
        })
      }

      if (!sameSet(spec.runAs, live.run_as ?? [])) {
        diffs.push({
          field: `${spec.name}.runAs`,
          expected: spec.runAs.join(', ') || 'none',
          actual: (live.run_as ?? []).join(', ') || 'none',
          severity: 'warning',
        })
      }

      const authoredIndices = spec.indicesJson ? (parseJsonArray(spec.indicesJson) ?? []) : []
      if (stableStringify(authoredIndices) !== stableStringify(live.indices ?? [])) {
        diffs.push({
          field: `${spec.name}.indices`,
          expected: stableStringify(authoredIndices),
          actual: stableStringify(live.indices ?? []),
          severity: 'critical',
        })
      }

      const authoredApplications = spec.applicationsJson ? (parseJsonArray(spec.applicationsJson) ?? []) : []
      if (stableStringify(authoredApplications) !== stableStringify(live.applications ?? [])) {
        diffs.push({
          field: `${spec.name}.applications`,
          expected: stableStringify(authoredApplications),
          actual: stableStringify(live.applications ?? []),
          severity: 'critical',
        })
      }

      const authoredMeta = spec.metadataJson ? (parseJsonObject(spec.metadataJson) ?? {}) : {}
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

      // An Elasticsearch role carries no modifier field and no per-object audit
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
