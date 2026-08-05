import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildAquaClient } from '../../lib/aquasec'
import { diffRuntimePolicy, extractRuntimePolicySpecs } from '../lib/runtimePolicy'

/**
 * Drift for host runtime policies: compare the declared policy against
 * the live one in Aqua. Best-effort — a lookup error for one policy is
 * treated as "no drift asserted" for that policy. Read-only: GET
 * /api/v2/runtime_policies/<name>.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const specs = extractRuntimePolicySpecs(ctx.canvas)
  const diffs: DriftDiff[] = []

  const built = buildAquaClient(ctx.component?.hostname ?? null, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  for (const spec of specs) {
    if (!spec.name) continue

    let live
    try {
      live = await client.getRuntimePolicy(spec.name)
    } catch {
      continue
    }

    if (!spec.enabled) {
      if (live) diffs.push({ field: `${spec.name}.enabled`, expected: false, actual: true, severity: 'warning' })
      continue
    }

    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'missing', severity: 'critical' })
      continue
    }

    diffs.push(...diffRuntimePolicy(spec, live))
  }

  return { hasDrift: diffs.length > 0, diffs }
}
