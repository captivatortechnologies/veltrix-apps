import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPingOneClient, stableStringify } from '../../lib/pingOne'
import { findRiskPolicySet } from './deploy'
import { extractRiskPolicySetSpecs, parseRiskPoliciesArray, stripPolicyPriority } from './validate'

/**
 * Detect drift between the deployed risk policy set configuration and the
 * live PingOne environment. Re-finds each declared set by name and compares:
 *   - `default` - whether it is the environment's default risk policy set
 *   - the evaluated-predictor id set (order-independent - compared sorted)
 *   - the full ordered `riskPolicies` array, after stripping each LIVE entry's
 *     server-assigned `priority` (derived from array position; it would
 *     otherwise always read as drift since it is never sent)
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildPingOneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractRiskPolicySetSpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    try {
      const live = await findRiskPolicySet(client, spec.name)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const liveDefault = live.default === true
      if (spec.default !== liveDefault) {
        diffs.push({
          field: `${spec.name}.default`,
          expected: spec.default,
          actual: liveDefault,
          severity: 'critical',
        })
      }

      const expectedPredictors = [...spec.evaluatedPredictorIds].sort()
      const livePredictors = extractPredictorIds(live.evaluatedPredictors).sort()
      if (stableStringify(expectedPredictors) !== stableStringify(livePredictors)) {
        diffs.push({
          field: `${spec.name}.evaluatedPredictors`,
          expected: expectedPredictors.length ? expectedPredictors.join(', ') : 'all licensed predictors',
          actual: livePredictors.length ? livePredictors.join(', ') : 'all licensed predictors',
          severity: 'critical',
        })
      }

      const expectedPolicies = spec.riskPoliciesJson ? (parseRiskPoliciesArray(spec.riskPoliciesJson) ?? []) : []
      const livePolicies = stripPolicyPriority(live.riskPolicies)
      if (stableStringify(expectedPolicies) !== stableStringify(livePolicies)) {
        diffs.push({
          field: `${spec.name}.riskPolicies`,
          expected: stableStringify(expectedPolicies),
          actual: stableStringify(livePolicies),
          severity: 'critical',
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

/** Pull each `{id}` entry's id out of a live `evaluatedPredictors` array. */
function extractPredictorIds(predictors: unknown): string[] {
  if (!Array.isArray(predictors)) return []
  return predictors
    .map((p) => (p && typeof p === 'object' ? (p as Record<string, unknown>).id : undefined))
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
}
