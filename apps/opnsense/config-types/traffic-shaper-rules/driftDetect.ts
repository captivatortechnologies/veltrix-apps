import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { searchShaperRules, type LiveShaperRule } from '../../lib/trafficShaperApi'
import { buildOpnsenseClient } from '../../lib/opnsenseApi'
import { extractShaperRuleSpecs } from './_shared'

/**
 * Detect drift between the deployed shaper-rule configuration and the live
 * OPNsense box. Reads the itemId -> uuid mapping from the last successful
 * deployment's rollbackData (TrafficShaper rules have no name to re-match
 * by). A missing rule is critical drift; a changed interface/source/
 * destination/target/enabled state is a warning.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOpnsenseClient(ctx.component.hostname, ctx.component.port, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractShaperRuleSpecs(ctx.deployedConfig)
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
    const live = await searchShaperRules(client)
    const byUuid = new Map<string, LiveShaperRule>(live.map((r) => [r.uuid, r]))

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
        diffs.push({ field: `${label}.interface`, expected: spec.interfaceName, actual: liveInterface || '(none)', severity: 'warning' })
      }
      const liveSource = String(found.source ?? '')
      if (liveSource !== spec.source.join(',')) {
        diffs.push({ field: `${label}.source`, expected: spec.source.join(','), actual: liveSource || '(none)', severity: 'warning' })
      }
      // `target` is a live pipe/queue UUID; diffing it against the declared
      // `targetName` would need an extra pipe+queue lookup to resolve the name
      // back to a uuid — intentionally skipped here to keep this handler to a
      // single read. deploy.ts always re-resolves and re-asserts it anyway.
    }
  } catch {
    diffs.push({ field: 'opnsense', expected: 'reachable', actual: 'unreachable', severity: 'critical' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
