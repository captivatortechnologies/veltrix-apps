import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildTenableClient } from '../../lib/tenable'
import { findNetworkByName } from './deploy'
import { extractNetworkSpecs } from './validate'

/**
 * Detect drift between the deployed network configuration and the live tenant
 * state. Re-finds each declared network by its name and diffs the managed
 * fields (description and, when the canvas sets one, the asset TTL).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractNetworkSpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    try {
      const live = await findNetworkByName(client, spec.name)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const liveDescription = (typeof live.description === 'string' ? live.description : '').trim()
      if ((spec.description ?? '') !== liveDescription) {
        diffs.push({
          field: `${spec.name}.description`,
          expected: spec.description ?? 'not set',
          actual: liveDescription || 'not set',
          severity: 'info',
        })
      }

      // Only compare the TTL the deployment manages — an absent canvas TTL means
      // "leave the tenant default", so it is not drift when they differ.
      if (spec.assetsTtlDays !== undefined && live.assets_ttl_days !== spec.assetsTtlDays) {
        diffs.push({
          field: `${spec.name}.assetsTtlDays`,
          expected: String(spec.assetsTtlDays),
          actual: live.assets_ttl_days !== undefined ? String(live.assets_ttl_days) : 'not set',
          severity: 'info',
        })
      }
    } catch (error) {
      diffs.push({
        field: spec.name,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
