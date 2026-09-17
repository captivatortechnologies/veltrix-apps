// =============================================================================
// Drift detection: compare the deployed detection rules against what is live.
//
// A declared rule that no longer exists is CRITICAL drift; a status or display
// name that no longer matches is a WARNING. Where Graph is unavailable (gov
// clouds) the result is marked `checked: false` — unchecked, not in sync.
// =============================================================================

import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildMdeClient } from '../../lib/mde'
import { attachDriftActor, ruleAuditEvents, veltrixActorLogins } from '../../lib/mdeAuditLog'
import { listRules } from './deploy'
import { extractDetectionRuleSpecs, ruleKey, type LiveRule } from './validate'

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []
  const built = buildMdeClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [], checked: false }
  const { client } = built

  // Graph is unavailable in gov clouds, so the live rules cannot be read at
  // all. `checked: false` says that; a bare `hasDrift: false` would tell the
  // platform the estate was verified and clear real drift found elsewhere on
  // every scheduled run.
  if (!client.graphAvailable) return { hasDrift: false, diffs: [], checked: false }

  const specs = extractDetectionRuleSpecs(ctx.deployedConfig).filter((s) => s.ruleId)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  // Veltrix's own deploys are stamped with the app registration identity —
  // excluded so attribution reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = await listRules(client)
    const byKey = new Map<string, LiveRule>(live.filter((r) => r.id).map((r) => [ruleKey(r.id as string), r]))
    for (const spec of specs) {
      const before = diffs.length
      const found = byKey.get(ruleKey(spec.ruleId))
      const label = spec.ruleId
      if (!found) {
        // Missing/deleted — the object's stamps are gone, so it is unattributable.
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      if (spec.status && (found.status ?? '') !== spec.status) {
        diffs.push({ field: `${label}.status`, expected: spec.status, actual: found.status ?? 'not set', severity: 'warning' })
      }
      if (spec.displayName && (found.displayName ?? '') !== spec.displayName) {
        diffs.push({ field: `${label}.displayName`, expected: spec.displayName, actual: found.displayName ?? 'not set', severity: 'warning' })
      }
      // Attribute every diff this rule produced to its last human change (once);
      // a no-op when the rule did not drift.
      attachDriftActor(diffs.slice(before), ruleAuditEvents(found), excludeActorLogins)
    }
  } catch (error) {
    diffs.push({ field: 'graph', expected: 'reachable', actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`, severity: 'critical' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
