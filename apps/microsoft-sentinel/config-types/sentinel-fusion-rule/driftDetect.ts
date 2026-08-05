import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSentinelClient } from '../../lib/sentinel'
import { attachDriftActor, veltrixActorLogins } from '../../lib/sentinelActivityLog'
import { findFusionRule } from './deploy'
import { extractFusionRuleSpecs } from './validate'

/** Used only to build a resource id for drift-actor lookup when the live ruleId is unknown. */
const FUSION_RESOURCE_FALLBACK = 'fusion'

/**
 * Detect drift between the deployed Fusion rule and the live workspace. A
 * declared Fusion rule that no longer exists is critical drift; a differing
 * `enabled` toggle is warning drift. Each drifted diff is attributed to the
 * last MANUAL change via the Azure Activity Log.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildSentinelClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractFusionRuleSpecs(ctx.deployedConfig)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }
  const spec = specs[0]

  // Veltrix's own deploys authenticate as the app registration — excluded so
  // attribution reflects the MANUAL change, not our deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = await findFusionRule(client)
    if (!live) {
      diffs.push({ field: 'fusion_rule', expected: 'exists', actual: 'missing', severity: 'critical' })
      const resourceId = client.sentinelPath(`/alertRules/${FUSION_RESOURCE_FALLBACK}`)
      await attachDriftActor(client, diffs, { resourceId, excludeActorLogins })
      return { hasDrift: true, diffs }
    }

    const resourceId = client.sentinelPath(`/alertRules/${live.name ?? FUSION_RESOURCE_FALLBACK}`)
    const haveEnabled = live.properties?.enabled === true
    if (spec.enabled !== haveEnabled) {
      diffs.push({ field: 'fusion_rule.enabled', expected: String(spec.enabled), actual: String(haveEnabled), severity: 'warning' })
    }
    await attachDriftActor(client, diffs, { resourceId, excludeActorLogins })
  } catch (error) {
    diffs.push({ field: 'sentinel', expected: 'reachable', actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`, severity: 'critical' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
