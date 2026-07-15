import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient } from '../../lib/zscaler'
import { listGreTunnels } from './deploy'
import { extractGreTunnelSpecs } from './validate'

/**
 * Detect drift between the deployed GRE tunnel configuration and the live
 * tenant. Re-finds each declared tunnel by source IP and diffs the managed
 * comment; a missing tunnel is critical drift.
 *
 * The advanced-tunnel fields (VIP objects, flags) live in the gre_json escape
 * hatch and are heavily server-normalized, so they are deliberately not
 * deep-diffed here — only presence + comment are checked.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractGreTunnelSpecs(ctx.deployedConfig).filter((s) => s.sourceIp)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listGreTunnels(client)
    const bySourceIp = new Map(live.filter((t) => t.sourceIp).map((t) => [t.sourceIp as string, t]))

    for (const spec of specs) {
      const found = bySourceIp.get(spec.sourceIp)
      if (!found) {
        diffs.push({ field: spec.sourceIp, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      const liveComment = (typeof found.comment === 'string' ? found.comment : '').trim()
      if ((spec.comment ?? '') !== liveComment) {
        diffs.push({
          field: `${spec.sourceIp}.comment`,
          expected: spec.comment ?? 'not set',
          actual: liveComment || 'not set',
          severity: 'info',
        })
      }
    }
  } catch (error) {
    diffs.push({
      field: 'zia',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
