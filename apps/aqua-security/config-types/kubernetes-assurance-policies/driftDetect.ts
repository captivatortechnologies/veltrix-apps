import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildAquaClient } from '../../lib/aquasec'
import { diffAssurancePolicy, extractAssurancePolicySpecs } from '../lib/assurancePolicy'

const ASSURANCE_TYPE = 'kubernetes' as const

/**
 * Drift for kubernetes assurance policies: compare the declared policy against
 * the live one in Aqua. Best-effort — a lookup error for one policy is
 * treated as "no drift asserted" for that policy rather than a false
 * positive. Read-only: GET /api/v2/assurance_policy/kubernetes/<name>.
 *
 * An enabled policy that is missing, or whose application scopes/enforce
 * mode diverged, is drift (critical). Other field differences are warnings.
 * A disabled policy that still exists is drift (this app removes it).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const specs = extractAssurancePolicySpecs(ctx.canvas)
  const diffs: DriftDiff[] = []

  const built = buildAquaClient(ctx.component?.hostname ?? null, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  for (const spec of specs) {
    if (!spec.name) continue

    let live
    try {
      live = await client.getAssurancePolicy(ASSURANCE_TYPE, spec.name)
    } catch {
      continue // best-effort: can't read this policy, no drift asserted
    }

    if (!spec.enabled) {
      if (live) diffs.push({ field: `${spec.name}.enabled`, expected: false, actual: true, severity: 'warning' })
      continue
    }

    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'missing', severity: 'critical' })
      continue
    }

    diffs.push(...diffAssurancePolicy(spec, live))
  }

  return { hasDrift: diffs.length > 0, diffs }
}
