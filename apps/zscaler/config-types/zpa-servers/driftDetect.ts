import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient } from '../../lib/zscaler'
import { listServers } from './deploy'
import { extractServerSpecs } from './validate'

/**
 * Detect drift between the deployed server configuration and the live tenant.
 * Re-finds each declared server by name and diffs the managed fields
 * (description, address, enabled); a missing server is critical drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built
  if (!client.hasCustomerId) return { hasDrift: false, diffs: [] }

  const specs = extractServerSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listServers(client)
    const byName = new Map(live.filter((s) => s.name).map((s) => [s.name as string, s]))

    for (const spec of specs) {
      const found = byName.get(spec.name)
      if (!found) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      const liveDescription = (typeof found.description === 'string' ? found.description : '').trim()
      if ((spec.description ?? '') !== liveDescription) {
        diffs.push({
          field: `${spec.name}.description`,
          expected: spec.description ?? 'not set',
          actual: liveDescription || 'not set',
          severity: 'info',
        })
      }
      const liveAddress = (typeof found.address === 'string' ? found.address : '').trim()
      if (spec.address !== liveAddress) {
        diffs.push({
          field: `${spec.name}.address`,
          expected: spec.address,
          actual: liveAddress || 'not set',
          severity: 'warning',
        })
      }
      const liveEnabled = found.enabled ?? true
      if (spec.enabled !== liveEnabled) {
        diffs.push({
          field: `${spec.name}.enabled`,
          expected: String(spec.enabled),
          actual: String(liveEnabled),
          severity: 'warning',
        })
      }
    }
  } catch (error) {
    diffs.push({
      field: 'zpa',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
