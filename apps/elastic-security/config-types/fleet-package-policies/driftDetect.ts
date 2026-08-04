import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient } from '../../lib/elastic'
import { attachDriftActor, veltrixActorLogins } from '../lib/elasticAudit'
import { listPolicies } from './deploy'
import { extractPolicySpecs, parseJsonArray, parseJsonObject } from './validate'

/**
 * Detect drift between the deployed Fleet package-policy configuration and the
 * live Fleet state. Re-lists policies and matches by name (Fleet assigns the
 * internal id), diffing the authored fields. A missing policy is critical drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildElasticClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const excludeActorLogins = veltrixActorLogins(ctx.credential)
  const specs = extractPolicySpecs(ctx.deployedConfig).filter((s) => s.name && s.inputsJson)

  try {
    const live = await listPolicies(client)
    const liveByName = new Map(live.filter((p) => p.name).map((p) => [p.name as string, p]))

    for (const spec of specs) {
      const found = liveByName.get(spec.name)
      if (!found) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const before = diffs.length

      const liveEnabled = found.enabled === true
      if (spec.enabled !== liveEnabled) {
        diffs.push({ field: `${spec.name}.enabled`, expected: spec.enabled, actual: liveEnabled, severity: 'critical' })
      }

      const liveNamespace = found.namespace ?? 'default'
      if (spec.namespace !== liveNamespace) {
        diffs.push({ field: `${spec.name}.namespace`, expected: spec.namespace, actual: liveNamespace, severity: 'warning' })
      }

      if (!sameSet(spec.policyIds, found.policy_ids ?? [])) {
        diffs.push({
          field: `${spec.name}.policyIds`,
          expected: spec.policyIds.join(', ') || 'none',
          actual: (found.policy_ids ?? []).join(', ') || 'none',
          severity: 'warning',
        })
      }

      if (spec.packageVersion !== found.package?.version) {
        diffs.push({
          field: `${spec.name}.package.version`,
          expected: spec.packageVersion,
          actual: found.package?.version ?? 'not set',
          severity: 'warning',
        })
      }

      const authoredInputs = spec.inputsJson ? (parseJsonArray(spec.inputsJson) ?? []) : []
      if (stableStringify(authoredInputs) !== stableStringify(found.inputs ?? [])) {
        diffs.push({
          field: `${spec.name}.inputs`,
          expected: stableStringify(authoredInputs),
          actual: stableStringify(found.inputs ?? []),
          severity: 'critical',
        })
      }

      const authoredVars = spec.varsJson ? (parseJsonObject(spec.varsJson) ?? {}) : {}
      if (stableStringify(authoredVars) !== stableStringify(found.vars ?? {})) {
        diffs.push({
          field: `${spec.name}.vars`,
          expected: stableStringify(authoredVars),
          actual: stableStringify(found.vars ?? {}),
          severity: 'info',
        })
      }

      // A Fleet package policy carries updated_at/updated_by, so this
      // attributes automatically when Fleet recorded a manual editor.
      attachDriftActor(diffs.slice(before), found, { excludeActorLogins })
    }
  } catch (error) {
    diffs.push({
      field: 'fleet-package-policies',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
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
