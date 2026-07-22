import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildS1Client } from '../../lib/s1'
import { attachDriftActor, veltrixActorLogins } from '../../lib/s1ActivityLog'
import { listStarRules } from './deploy'
import { extractStarRuleSpecs, isRuleActive, ruleKey, type LiveStarRule } from './validate'

/**
 * Detect drift between the deployed STAR rule configuration and the live scope.
 * Re-finds each declared rule by name and diffs the managed fields: a missing
 * rule is critical drift; a changed severity or a changed activation state
 * (Active vs Draft) is a warning.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildS1Client(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built
  if (!client.hasScope) return { hasDrift: false, diffs: [] }

  const specs = extractStarRuleSpecs(ctx.deployedConfig).filter((s) => s.name && s.s1ql)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listStarRules(client)
    const byName = new Map<string, LiveStarRule>(
      live.filter((r) => r.name).map((r) => [ruleKey(r.name as string), r]),
    )

    const veltrixLogins = veltrixActorLogins(ctx.credential)
    const attributions: Array<Promise<void>> = []

    for (const spec of specs) {
      const label = spec.name
      const before = diffs.length
      const found = byName.get(ruleKey(spec.name))
      if (!found) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
      } else {
        if ((found.severity ?? '') !== spec.severity) {
          diffs.push({ field: `${label}.severity`, expected: spec.severity, actual: found.severity ?? 'not set', severity: 'warning' })
        }
        const liveActive = isRuleActive(found.status)
        if (liveActive !== spec.activate) {
          diffs.push({
            field: `${label}.status`,
            expected: spec.activate ? 'Active' : 'Draft',
            actual: found.status ?? (liveActive ? 'Active' : 'Draft'),
            severity: 'warning',
          })
        }
      }

      // Best-effort "who changed it + when" for this rule's drift only.
      const objectDiffs = diffs.slice(before)
      if (objectDiffs.length > 0) {
        attributions.push(
          attachDriftActor(client, objectDiffs, {
            targetId: found?.id,
            targetName: spec.name,
            excludeActorLogins: veltrixLogins,
          }),
        )
      }
    }
    await Promise.all(attributions)
  } catch (error) {
    diffs.push({
      field: 'sentinelone',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
