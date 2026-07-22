import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient } from '../../lib/okta'
import { attachDriftActor, veltrixActorLogins } from '../lib/oktaSystemLog'
import { findGroupRuleByName } from './deploy'
import { extractGroupRuleSpecs, liveExpression, liveGroupIds, sameGroupIds } from './validate'

/**
 * Detect drift between the deployed group-rule configuration and the live org.
 * Re-finds each declared rule by name and diffs the meaningful, user-owned
 * fields only — the server-managed readOnly fields (id, created, lastUpdated,
 * system, _links, _embedded) are never compared. `status` is compared
 * separately as a WARNING because it changes through the lifecycle endpoints,
 * not through a rule edit.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractGroupRuleSpecs(ctx.deployedConfig).filter(
    (s) => s.name && s.expression && s.groupIds.length > 0,
  )

  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  for (const spec of specs) {
    const before = diffs.length
    const label = spec.name
    try {
      const live = await findGroupRuleByName(client, spec.name)

      if (!live) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        // Deleted/absent — no live id; attribute by name (best-effort).
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.name, excludeActorLogins })
        continue
      }

      // Expression — the condition deciding which users the rule assigns.
      const actualExpr = liveExpression(live)
      if (spec.expression !== actualExpr) {
        diffs.push({
          field: `${label}.expression`,
          expected: spec.expression,
          actual: actualExpr || 'not set',
          severity: 'critical',
        })
      }

      // Target groups — a SET comparison (order-independent). These are the
      // immutable actions block; drift here means the rule was rebuilt/edited
      // out of band.
      const actualGroups = liveGroupIds(live)
      if (!sameGroupIds(spec.groupIds, actualGroups)) {
        diffs.push({
          field: `${label}.groupIds`,
          expected: spec.groupIds.join(', ') || 'none',
          actual: actualGroups.join(', ') || 'none',
          severity: 'critical',
        })
      }

      // Status — lifecycle-managed, so surfaced as a lighter warning.
      const actualStatus = (live.status ?? '').toUpperCase()
      if (spec.status !== actualStatus) {
        diffs.push({
          field: `${label}.status`,
          expected: spec.status,
          actual: actualStatus || 'unknown',
          severity: 'warning',
        })
      }

      // Attribute every diff this rule produced to the last human change (once).
      await attachDriftActor(client, diffs.slice(before), {
        targetId: live.id,
        targetName: spec.name,
        excludeActorLogins,
      })
    } catch (error) {
      diffs.push({
        field: label,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
