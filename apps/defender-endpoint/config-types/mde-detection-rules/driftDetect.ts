// =============================================================================
// Drift detection: compare the deployed detection rules against what is live.
//
// A declared rule that no longer exists is CRITICAL drift; a status or display
// name that no longer matches is a WARNING. Returns a neutral (no-drift) result
// when Graph is unavailable (gov clouds) so drift never false-alarms there.
// =============================================================================

import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildMdeClient } from '../../lib/mde'
import { listRules } from './deploy'
import { extractDetectionRuleSpecs, ruleKey, type LiveRule } from './validate'

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []
  const built = buildMdeClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  if (!client.graphAvailable) return { hasDrift: false, diffs: [] }

  const specs = extractDetectionRuleSpecs(ctx.deployedConfig).filter((s) => s.ruleId)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listRules(client)
    const byKey = new Map<string, LiveRule>(live.filter((r) => r.id).map((r) => [ruleKey(r.id as string), r]))
    for (const spec of specs) {
      const found = byKey.get(ruleKey(spec.ruleId))
      const label = spec.ruleId
      if (!found) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      if (spec.status && (found.status ?? '') !== spec.status) {
        diffs.push({ field: `${label}.status`, expected: spec.status, actual: found.status ?? 'not set', severity: 'warning' })
      }
      if (spec.displayName && (found.displayName ?? '') !== spec.displayName) {
        diffs.push({ field: `${label}.displayName`, expected: spec.displayName, actual: found.displayName ?? 'not set', severity: 'warning' })
      }
    }
  } catch (error) {
    diffs.push({ field: 'graph', expected: 'reachable', actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`, severity: 'critical' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
