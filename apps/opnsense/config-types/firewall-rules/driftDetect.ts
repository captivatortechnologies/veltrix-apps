import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildOpnsenseClient, searchFilterRules, type LiveFilterRule } from '../../lib/opnsenseApi'
import { extractFilterRuleSpecs } from './_shared'

/**
 * Detect drift between the deployed filter-rule configuration and the live
 * OPNsense box. Since a pf rule has no name to re-find live rules by, this
 * reads the itemId -> uuid mapping from the LAST successful deployment's
 * rollbackData (the same tracking deploy.ts writes) rather than re-matching
 * by any field value. A missing rule is critical drift; a changed
 * action/interface/direction/protocol/source/destination/log/enabled state is
 * a warning. Read-only.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOpnsenseClient(ctx.component.hostname, ctx.component.port, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractFilterRuleSpecs(ctx.deployedConfig)
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
    const live = await searchFilterRules(client)
    const byUuid = new Map<string, LiveFilterRule>(live.map((r) => [r.uuid, r]))

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
      const liveAction = String(found.action ?? '')
      if (liveAction !== spec.action) {
        diffs.push({ field: `${label}.action`, expected: spec.action, actual: liveAction || '(none)', severity: 'critical' })
      }
      const liveInterface = String(found.interface ?? '')
      if (liveInterface !== spec.interface.join(',')) {
        diffs.push({ field: `${label}.interface`, expected: spec.interface.join(',') || '(floating)', actual: liveInterface || '(floating)', severity: 'warning' })
      }
      const liveDirection = String(found.direction ?? '')
      if (liveDirection !== spec.direction) {
        diffs.push({ field: `${label}.direction`, expected: spec.direction, actual: liveDirection || '(none)', severity: 'warning' })
      }
      const liveSourceNet = String(found.source_net ?? '')
      if (liveSourceNet !== spec.sourceNet.join(',')) {
        diffs.push({ field: `${label}.source_net`, expected: spec.sourceNet.join(','), actual: liveSourceNet || '(none)', severity: 'warning' })
      }
      const liveDestinationNet = String(found.destination_net ?? '')
      if (liveDestinationNet !== spec.destinationNet.join(',')) {
        diffs.push({ field: `${label}.destination_net`, expected: spec.destinationNet.join(','), actual: liveDestinationNet || '(none)', severity: 'warning' })
      }
      const liveLog = String(found.log ?? '0') === '1'
      if (liveLog !== spec.log) {
        diffs.push({ field: `${label}.log`, expected: spec.log ? 'on' : 'off', actual: liveLog ? 'on' : 'off', severity: 'info' })
      }
    }
  } catch {
    diffs.push({ field: 'opnsense', expected: 'reachable', actual: 'unreachable', severity: 'critical' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
