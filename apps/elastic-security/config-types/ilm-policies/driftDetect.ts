import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient } from '../../lib/elastic'
import { attachDriftActor, veltrixActorLogins } from '../lib/elasticAudit'
import { getIlmPolicy } from './deploy'
import { extractIlmPolicySpecs, parsePolicyObject } from './validate'

/**
 * Detect drift between the deployed ILM policy configuration and the live
 * cluster state. Re-reads each declared policy and diffs ONLY the `.policy`
 * object (the server-managed `version` / `modified_date` siblings are stripped —
 * the GET response is `{ "<name>": { version, modified_date, policy } }`).
 *
 * Elasticsearch normalizes a stored policy (it injects default action settings
 * and a `min_age` per phase), so the comparison is a DEEP SUBSET check: every
 * key/value the config authored must be present and equal in the live policy.
 * Extra keys the server added on its own do not count as drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildElasticClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  // Connection identity our own deploys are recorded under — excluded so
  // attribution reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  const specs = extractIlmPolicySpecs(ctx.deployedConfig).filter((s) => s.name && s.policyJson)

  for (const spec of specs) {
    try {
      const live = await getIlmPolicy(client, spec.name)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const authored = spec.policyJson ? parsePolicyObject(spec.policyJson) : null
      if (!authored) continue // malformed authored JSON is a validate concern, not drift

      const before = diffs.length
      const livePolicy = live.policy ?? {}
      if (!isDeepSubset(authored, livePolicy)) {
        diffs.push({
          field: `${spec.name}.policy`,
          expected: stableStringify(authored),
          actual: stableStringify(livePolicy),
          severity: 'warning',
        })
      }

      // An Elasticsearch ILM policy exposes only `modified_date` (a WHEN, no WHO)
      // and no per-object audit trail via this API, so this resolves to no actor
      // ("—"). Wired uniformly so it attributes automatically if ES ever records
      // a modifier — best-effort, never fabricated.
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

/**
 * Deep-subset check: every key/value in `authored` must appear, equal, in
 * `live`. Objects recurse key-by-key (extra live keys are ignored); arrays must
 * match element-for-element; primitives must be strictly equal.
 */
export function isDeepSubset(authored: unknown, live: unknown): boolean {
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
