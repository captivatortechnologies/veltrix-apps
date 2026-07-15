import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient } from '../../lib/zscaler'
import { listApplicationSegments } from './deploy'
import { extractApplicationSegmentSpecs } from './validate'

/**
 * Detect drift between the deployed application segment configuration and the
 * live tenant. Re-finds each declared segment by name and diffs the managed
 * scalar fields (description, enabled) plus the domain name set (order-insensitive);
 * a missing segment is critical drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built
  if (!client.hasCustomerId) return { hasDrift: false, diffs: [] }

  const specs = extractApplicationSegmentSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listApplicationSegments(client)
    const byName = new Map(live.filter((a) => a.name).map((a) => [a.name as string, a]))

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

      const liveEnabled = found.enabled ?? true
      if (spec.enabled !== liveEnabled) {
        diffs.push({
          field: `${spec.name}.enabled`,
          expected: String(spec.enabled),
          actual: String(liveEnabled),
          severity: 'warning',
        })
      }

      const expectedDomains = [...spec.domainNames].sort()
      const liveDomains = (Array.isArray(found.domainNames) ? found.domainNames.map(String) : []).sort()
      if (JSON.stringify(expectedDomains) !== JSON.stringify(liveDomains)) {
        diffs.push({
          field: `${spec.name}.domainNames`,
          expected: expectedDomains.join(', ') || 'none',
          actual: liveDomains.join(', ') || 'none',
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
