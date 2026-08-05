import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSophosClient } from '../../lib/sophosCentral'
import { listPolicies } from '../../lib/sophosApi'
import { declaredPolicyProjection, extractPolicySpecs, parsePolicySpec, policyKey, policyMatches } from './_shared'

/**
 * Detect drift for endpoint policies: for each declared (name, type) pair,
 * find the live policy and compare every declared field. A declared policy
 * that no longer exists is critical drift; a changed field is a warning.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildSophosClient(ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractPolicySpecs(ctx.deployedConfig).filter((s) => s.name && s.type)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  let live
  try {
    live = await listPolicies(client)
  } catch {
    return { hasDrift: false, diffs: [] }
  }
  const liveByKey = new Map(live.filter((p) => p.name && p.type).map((p) => [policyKey(p.name, p.type), p] as const))

  for (const spec of specs) {
    const label = `${spec.name} (${spec.type})`
    const match = liveByKey.get(policyKey(spec.name, spec.type))
    if (!match) {
      diffs.push({ field: label, expected: 'present', actual: 'missing', severity: 'critical' })
      continue
    }

    const { value: parsed } = parsePolicySpec(spec)
    if (!parsed) continue
    if (!policyMatches(parsed, match)) {
      diffs.push({
        field: `${label}.policy`,
        expected: declaredPolicyProjection(parsed),
        actual: {
          name: match.name,
          enabled: match.enabled ?? true,
          priority: match.priority ?? null,
          disableAt: match.disableAt ?? null,
          appliesTo: match.appliesTo ?? {},
          settings: match.settings ?? {},
        },
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
