import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient } from '../../lib/zscaler'
import { listLocations } from './deploy'
import { extractLocationSpecs } from './validate'

/**
 * Detect drift between the deployed location configuration and the live tenant.
 *
 * PRESENCE ONLY. Unlike simpler ZIA objects, a location carries many
 * server-managed fields — ZIA derives, normalizes and augments the payload
 * (geo/coordinates from the country, resolved sub-locations, computed policy
 * flags, VPN credential expansions, timestamps). Scalar-diffing those against
 * the authored spec would report perpetual, noisy false drift, so this only
 * re-finds each declared location by name; a missing location is critical drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractLocationSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listLocations(client)
    const names = new Set(live.filter((l) => l.name).map((l) => l.name as string))

    for (const spec of specs) {
      if (!names.has(spec.name)) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
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
