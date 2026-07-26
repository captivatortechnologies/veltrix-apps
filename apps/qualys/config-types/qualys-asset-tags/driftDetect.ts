import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildQualysClient } from '../../lib/qualys'
import { attachDriftActor, veltrixActorLogins } from '../lib/qualysActivityLog'
import { listAssetTags, normalizeColor } from './deploy'
import { assetTagKey, extractAssetTagSpecs, isDynamicRule, type LiveAssetTag } from './validate'

/**
 * Detect drift between the deployed asset tag configuration and the live
 * platform. Re-finds each declared tag by name and diffs the managed fields
 * (rule type, rule text, color, criticality); a missing tag is critical drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildQualysClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractAssetTagSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  // Connection identity our own deploys appear under — excluded so attribution
  // reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = await listAssetTags(client)
    const byKey = new Map<string, LiveAssetTag>(live.map((t) => [assetTagKey(t), t]))

    for (const spec of specs) {
      const before = diffs.length
      const found = byKey.get(assetTagKey(spec))
      if (!found) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        // Deleted/absent — no live id; attribute by name (best-effort).
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.name, excludeActorLogins })
        continue
      }

      const wantType = isDynamicRule(spec.ruleType) ? spec.ruleType : 'STATIC'
      const gotType = isDynamicRule(found.ruleType) ? found.ruleType : 'STATIC'
      if (wantType !== gotType) {
        diffs.push({ field: `${spec.name}.rule_type`, expected: wantType, actual: gotType, severity: 'warning' })
      }
      if (isDynamicRule(spec.ruleType) && found.ruleText !== spec.ruleText) {
        diffs.push({
          field: `${spec.name}.rule_text`,
          expected: spec.ruleText || 'not set',
          actual: found.ruleText || 'not set',
          severity: 'warning',
        })
      }
      if (spec.color) {
        const want = normalizeColor(spec.color)
        const got = found.color ? normalizeColor(found.color) : ''
        if (want !== got) {
          diffs.push({ field: `${spec.name}.color`, expected: want, actual: got || 'not set', severity: 'info' })
        }
      }
      if (spec.criticalityScore && found.criticalityScore !== spec.criticalityScore) {
        diffs.push({
          field: `${spec.name}.criticality_score`,
          expected: spec.criticalityScore,
          actual: found.criticalityScore || 'not set',
          severity: 'info',
        })
      }

      // Attribute every diff this tag produced to the last human change (once).
      await attachDriftActor(client, diffs.slice(before), {
        targetId: found.id,
        targetName: spec.name,
        excludeActorLogins,
      })
    }
  } catch (error) {
    diffs.push({
      field: 'qualys',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
