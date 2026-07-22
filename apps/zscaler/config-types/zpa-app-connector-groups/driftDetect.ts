import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient } from '../../lib/zscaler'
import { attachDriftActor, veltrixActorLogins } from '../lib/zscalerAudit'
import { listAppConnectorGroups } from './deploy'
import { extractAppConnectorGroupSpecs } from './validate'

/**
 * Detect drift between the deployed App Connector group configuration and the
 * live tenant. Re-finds each declared group by name and diffs the managed
 * scalar fields (description, enabled, location); a missing group is critical
 * drift. Returns no drift when no ZPA customer id is configured.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built
  const excludeActorLogins = veltrixActorLogins(ctx.credential)
  if (!client.hasCustomerId) return { hasDrift: false, diffs: [] }

  const specs = extractAppConnectorGroupSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listAppConnectorGroups(client)
    const byName = new Map(live.filter((g) => g.name).map((g) => [g.name as string, g]))

    for (const spec of specs) {
      const found = byName.get(spec.name)
      if (!found) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      const before = diffs.length
      const liveDescription = (typeof found.description === 'string' ? found.description : '').trim()
      if ((spec.description ?? '') !== liveDescription) {
        diffs.push({
          field: `${spec.name}.description`,
          expected: spec.description ?? 'not set',
          actual: liveDescription || 'not set',
          severity: 'info',
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
      const liveLocation = (typeof found.location === 'string' ? found.location : '').trim()
      if (spec.location !== liveLocation) {
        diffs.push({
          field: `${spec.name}.location`,
          expected: spec.location || 'not set',
          actual: liveLocation || 'not set',
          severity: 'warning',
        })
      }
      attachDriftActor(diffs.slice(before), found, { excludeActorLogins })
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
