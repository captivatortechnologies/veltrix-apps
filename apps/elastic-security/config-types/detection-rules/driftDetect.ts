import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient } from '../../lib/elastic'
import { getRuleByRuleId } from './deploy'
import { extractRuleSpecs, parseRuleObject, stripServerFields } from './validate'

/**
 * Detect drift between the deployed detection-rule configuration and the live
 * deployment. Re-reads each declared rule by rule_id and diffs the managed
 * fields: the modelled `name` / `enabled`, plus every key the author put in the
 * Definition JSON.
 *
 * SUBSET SEMANTICS: Kibana injects a large set of per-type defaults and
 * server-managed fields into a rule, so a naive whole-object diff would report
 * endless phantom drift. Instead this compares ONLY the keys the author declared
 * (a subset), and for nested objects recurses key-by-key — the live rule may be a
 * superset. Server-managed fields (id / revision / created_* / updated_* /
 * execution_summary) are stripped before comparison. `version` is not authored
 * (it is create-only) so it is never diffed.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildElasticClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractRuleSpecs(ctx.deployedConfig).filter((s) => s.ruleId && s.name)

  for (const spec of specs) {
    const label = spec.ruleId
    try {
      const live = await getRuleByRuleId(client, spec.ruleId)

      if (!live) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      // Strip server-managed fields so they never read as drift.
      const liveClean = stripServerFields(live)

      // name / enabled come from the modelled fields (they always win on deploy).
      if (spec.name !== (typeof liveClean.name === 'string' ? liveClean.name : '')) {
        diffs.push({
          field: `${label}.name`,
          expected: spec.name,
          actual: (liveClean.name as string) ?? 'not set',
          severity: 'warning',
        })
      }
      const liveEnabled = liveClean.enabled === true
      if (spec.enabled !== liveEnabled) {
        diffs.push({
          field: `${label}.enabled`,
          expected: spec.enabled,
          actual: liveEnabled,
          severity: 'warning',
        })
      }

      // Authored Definition keys — subset comparison against the live rule.
      const ruleObj = spec.ruleJson ? parseRuleObject(spec.ruleJson) : null
      if (ruleObj) {
        const authored = stripServerFields(ruleObj)
        // These are managed via the modelled fields above (or not authored) —
        // don't double-compare them here.
        delete authored.version
        delete authored.rule_id
        delete authored.name
        delete authored.enabled

        for (const key of Object.keys(authored)) {
          if (!deepSubsetEqual(authored[key], liveClean[key])) {
            diffs.push({
              field: `${label}.${key}`,
              expected: stableStringify(authored[key]),
              actual: key in liveClean ? stableStringify(liveClean[key]) : 'not set',
              severity: 'warning',
            })
          }
        }
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

/**
 * Subset-aware deep equality: does `actual` satisfy everything `expected`
 * declares? Objects recurse key-by-key (the author's subset must match; the live
 * object may carry extra keys). Arrays and primitives compare exactly, with
 * object keys canonicalized so key order / whitespace never read as drift.
 */
export function deepSubsetEqual(expected: unknown, actual: unknown): boolean {
  if (expected === null || typeof expected !== 'object') {
    return stableStringify(expected) === stableStringify(actual)
  }
  if (Array.isArray(expected)) {
    return stableStringify(expected) === stableStringify(actual)
  }
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false
  const exp = expected as Record<string, unknown>
  const act = actual as Record<string, unknown>
  return Object.keys(exp).every((k) => deepSubsetEqual(exp[k], act[k]))
}

/** Deterministic JSON stringify with recursively sorted object keys. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}
