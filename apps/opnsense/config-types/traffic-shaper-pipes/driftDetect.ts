import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { searchPipes, type LivePipe } from '../../lib/trafficShaperApi'
import { buildOpnsenseClient } from '../../lib/opnsenseApi'
import { extractPipeSpecs, pipeKey } from './_shared'

/**
 * Detect drift between the deployed pipe configuration and the live
 * OPNsense box. Re-finds each declared pipe by description and diffs the
 * managed fields: a missing pipe is critical drift; a changed bandwidth or
 * enabled state is a warning.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOpnsenseClient(ctx.component.hostname, ctx.component.port, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractPipeSpecs(ctx.deployedConfig).filter((s) => s.description)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await searchPipes(client)
    const byKey = new Map<string, LivePipe>(live.filter((p) => p.description).map((p) => [pipeKey(p.description as string), p]))

    for (const spec of specs) {
      const found = byKey.get(pipeKey(spec.description))

      if (!found) {
        diffs.push({ field: spec.description, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const liveEnabled = String(found.enabled ?? '1') === '1'
      if (liveEnabled !== spec.enabled) {
        diffs.push({
          field: `${spec.description}.enabled`,
          expected: spec.enabled ? 'enabled' : 'disabled',
          actual: liveEnabled ? 'enabled' : 'disabled',
          severity: 'warning',
        })
      }
      const liveBandwidth = `${found.bandwidth ?? ''}${found.bandwidthMetric ?? ''}`
      const specBandwidth = `${spec.bandwidth}${spec.bandwidthMetric}`
      if (liveBandwidth !== specBandwidth) {
        diffs.push({ field: `${spec.description}.bandwidth`, expected: specBandwidth, actual: liveBandwidth || '(none)', severity: 'warning' })
      }
    }
  } catch {
    diffs.push({ field: 'opnsense', expected: 'reachable', actual: 'unreachable', severity: 'critical' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
