import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildOpnsenseClient, searchSourceNatRules, type LiveSourceNatRule } from '../../lib/opnsenseApi'
import { extractSourceNatRuleSpecs } from './_shared'

/**
 * Detect drift between the deployed source-NAT configuration and the live
 * OPNsense box. Like firewall-rules, this reads the itemId -> uuid mapping
 * from the last successful deployment's rollbackData rather than re-matching
 * by any field value (snatrules.rule has no name). A missing rule is
 * critical drift; a changed interface/source/destination/target/enabled
 * state is a warning.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOpnsenseClient(ctx.component.hostname, ctx.component.port, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractSourceNatRuleSpecs(ctx.deployedConfig)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  let deployment
  try {
    deployment = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
  } catch {
    return { hasDrift: false, diffs: [] }
  }
  const rollbackEntries = (deployment?.rollbackData as { entries?: Array<{ itemId: string; uuid?: string }> } | undefined)?.entries ?? []
  const uuidByItemId = new Map(rollbackEntries.filter((e) => e.uuid).map((e) => [e.itemId, e.uuid as string]))

  try {
    const live = await searchSourceNatRules(client)
    const byUuid = new Map<string, LiveSourceNatRule>(live.map((r) => [r.uuid, r]))

    for (const spec of specs) {
      const label = spec.description || spec.itemId
      const uuid = uuidByItemId.get(spec.itemId)
      const found = uuid ? byUuid.get(uuid) : undefined

      if (!found) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const liveEnabled = String(found.enabled ?? '1') === '1'
      if (liveEnabled !== spec.enabled) {
        diffs.push({ field: `${label}.enabled`, expected: spec.enabled ? 'enabled' : 'disabled', actual: liveEnabled ? 'enabled' : 'disabled', severity: 'warning' })
      }
      const liveInterface = String(found.interface ?? '')
      if (liveInterface !== spec.interfaceName) {
        diffs.push({ field: `${label}.interface`, expected: spec.interfaceName, actual: liveInterface || '(none)', severity: 'critical' })
      }
      const liveSourceNet = String(found.source_net ?? '')
      if (liveSourceNet !== spec.sourceNet) {
        diffs.push({ field: `${label}.source_net`, expected: spec.sourceNet, actual: liveSourceNet || '(none)', severity: 'warning' })
      }
      const liveTarget = String(found.target ?? '')
      if (liveTarget !== spec.target) {
        diffs.push({ field: `${label}.target`, expected: spec.target || '(interface address)', actual: liveTarget || '(interface address)', severity: 'warning' })
      }
    }
  } catch {
    diffs.push({ field: 'opnsense', expected: 'reachable', actual: 'unreachable', severity: 'critical' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
