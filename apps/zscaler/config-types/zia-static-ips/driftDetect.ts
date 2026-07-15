import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient } from '../../lib/zscaler'
import { listStaticIps } from './deploy'
import { extractStaticIpSpecs } from './validate'

/**
 * Detect drift between the deployed static IP configuration and the live tenant.
 * Re-finds each declared static IP by its IP address and diffs the managed
 * scalar fields (comment, geoOverride); a missing static IP is critical drift.
 * The derived latitude/longitude are not diffed — ZIA recomputes them from the
 * IP when geoOverride is off, which makes a scalar diff far too noisy.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractStaticIpSpecs(ctx.deployedConfig).filter((s) => s.ipAddress)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listStaticIps(client)
    const byIp = new Map(live.filter((s) => s.ipAddress).map((s) => [s.ipAddress as string, s]))

    for (const spec of specs) {
      const found = byIp.get(spec.ipAddress)
      if (!found) {
        diffs.push({ field: spec.ipAddress, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const liveComment = (typeof found.comment === 'string' ? found.comment : '').trim()
      if ((spec.comment ?? '') !== liveComment) {
        diffs.push({
          field: `${spec.ipAddress}.comment`,
          expected: spec.comment ?? 'not set',
          actual: liveComment || 'not set',
          severity: 'info',
        })
      }

      const liveGeo = found.geoOverride === true
      if (spec.geoOverride !== liveGeo) {
        diffs.push({
          field: `${spec.ipAddress}.geoOverride`,
          expected: String(spec.geoOverride),
          actual: String(liveGeo),
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
