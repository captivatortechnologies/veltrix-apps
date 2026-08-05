import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildAquaClient } from '../../lib/aquasec'
import { diffEnforcerGroup, extractEnforcerGroupSpecs } from './_shared'

/**
 * Drift for enforcer groups: compare the declared protection configuration
 * against the live group in Aqua. Best-effort — a lookup error for one group
 * is treated as "no drift asserted" for that group. Read-only: GET
 * /api/v1/hostsbatch/<groupId>.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const specs = extractEnforcerGroupSpecs(ctx.canvas)
  const diffs: DriftDiff[] = []

  const built = buildAquaClient(ctx.component?.hostname ?? null, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  for (const spec of specs) {
    if (!spec.groupId) continue

    let live
    try {
      live = await client.getEnforcerGroup(spec.groupId)
    } catch {
      continue
    }

    if (!live) {
      diffs.push({ field: spec.groupId, expected: 'present', actual: 'missing', severity: 'critical' })
      continue
    }

    diffs.push(...diffEnforcerGroup(spec, live))
  }

  return { hasDrift: diffs.length > 0, diffs }
}
