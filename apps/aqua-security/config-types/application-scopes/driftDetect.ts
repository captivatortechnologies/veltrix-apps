import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildAquaClient } from '../../lib/aquasec'
import { diffApplicationScope, extractApplicationScopeSpecs } from './_shared'

/**
 * Drift for application scopes: compare the declared scope against the live
 * one in Aqua. Best-effort — a lookup error for one scope is treated as "no
 * drift asserted" for that scope. Read-only: GET
 * /api/v2/access_management/scopes/<name>.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const specs = extractApplicationScopeSpecs(ctx.canvas)
  const diffs: DriftDiff[] = []

  const built = buildAquaClient(ctx.component?.hostname ?? null, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  for (const spec of specs) {
    if (!spec.name) continue

    let live
    try {
      live = await client.getApplicationScope(spec.name)
    } catch {
      continue
    }

    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'missing', severity: 'critical' })
      continue
    }

    diffs.push(...diffApplicationScope(spec, live))
  }

  return { hasDrift: diffs.length > 0, diffs }
}
