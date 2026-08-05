import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildAquaClient } from '../../lib/aquasec'
import { diffFirewallPolicy, extractFirewallPolicySpecs } from './_shared'

/**
 * Drift for firewall policies: compare the declared policy against the live
 * one in Aqua. Best-effort — a lookup error for one policy is treated as "no
 * drift asserted" for that policy. Read-only: GET
 * /api/v2/firewall_policies/<name>.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const specs = extractFirewallPolicySpecs(ctx.canvas)
  const diffs: DriftDiff[] = []

  const built = buildAquaClient(ctx.component?.hostname ?? null, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  for (const spec of specs) {
    if (!spec.name) continue

    let live
    try {
      live = await client.getFirewallPolicy(spec.name)
    } catch {
      continue
    }

    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'missing', severity: 'critical' })
      continue
    }

    diffs.push(...diffFirewallPolicy(spec, live))
  }

  return { hasDrift: diffs.length > 0, diffs }
}
