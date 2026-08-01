import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSecretServerClient, normalizeBool } from '../../lib/secretServerApi'
import { extractPolicySpecs, searchPolicies, findPolicyByName } from './_shared'

/**
 * Drift for secret policies: for each declared policy, re-find it by name and
 * compare the managed fields (active, description). A policy that can't be found
 * is critical drift. Best-effort — a read error asserts no drift rather than
 * raising a false critical. Read-only: GET /api/v1/secret-policy/search.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildSecretServerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const items = ctx.deployedConfig.items ?? ctx.deployedConfig.sections ?? []
  const specs = extractPolicySpecs(items).filter((s) => s.secretPolicyName)
  if (specs.length === 0) return { hasDrift: false, diffs }

  try {
    for (const spec of specs) {
      const matches = await searchPolicies(client, spec.secretPolicyName)
      const match = findPolicyByName(matches, spec.secretPolicyName)
      if (!match) {
        diffs.push({ field: spec.secretPolicyName, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      if (match.active !== undefined && normalizeBool(match.active) !== spec.active) {
        diffs.push({
          field: `${spec.secretPolicyName}.active`,
          expected: spec.active,
          actual: normalizeBool(match.active),
          severity: 'warning',
        })
      }
      if (
        spec.secretPolicyDescription &&
        match.secretPolicyDescription !== undefined &&
        String(match.secretPolicyDescription) !== spec.secretPolicyDescription
      ) {
        diffs.push({
          field: `${spec.secretPolicyName}.secretPolicyDescription`,
          expected: spec.secretPolicyDescription,
          actual: String(match.secretPolicyDescription),
          severity: 'warning',
        })
      }
    }
  } catch {
    return { hasDrift: false, diffs } // best-effort: unreadable → no drift asserted
  }

  return { hasDrift: diffs.length > 0, diffs }
}
