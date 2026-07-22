import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient } from '../../lib/cloudflare'
import { attachDriftActor, veltrixActorLogins } from '../lib/cloudflareAudit'
import { listAccessGroups } from './deploy'
import { extractAccessGroupSpecs, type LiveAccessGroup } from './validate'

/**
 * Detect drift between the deployed Access group configuration and the live
 * account. Re-finds each declared group by its `name`; a missing group is
 * critical drift.
 *
 * We intentionally report PRESENCE ONLY and do NOT deep-diff the include /
 * exclude / require rule arrays. Those are arbitrarily nested Cloudflare rule
 * objects whose server-normalized shape (key ordering, injected defaults,
 * canonicalized selectors) rarely matches the raw JSON a user typed, so a
 * structural diff would flag constant false drift. Presence is the reliable,
 * meaningful signal; rule-content changes are managed by re-deploying.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  // Account-scoped: without a resolvable account id there is nothing to compare.
  if (!(await client.hasAccount())) {
    return { hasDrift: false, diffs: [] }
  }

  const specs = extractAccessGroupSpecs(ctx.deployedConfig).filter((s) => s.name && s.includeJson.trim())
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  // Connection identity our own deploys appear under — excluded so attribution
  // reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = await listAccessGroups(client)
    const byName = new Map<string, LiveAccessGroup>(live.filter((g) => g.name).map((g) => [g.name as string, g]))

    for (const spec of specs) {
      const before = diffs.length
      const found = byName.get(spec.name)
      if (!found) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        // Deleted/absent — no live id; attribute the deletion by name (best-effort).
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.name, excludeActorLogins })
      }
      // Presence only — see the module comment on why the rule arrays are not diffed.
    }
  } catch (error) {
    diffs.push({
      field: 'cloudflare',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
