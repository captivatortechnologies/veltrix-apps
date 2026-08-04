import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { searchQueues, type LiveQueue } from '../../lib/trafficShaperApi'
import { buildOpnsenseClient } from '../../lib/opnsenseApi'
import { extractQueueSpecs, queueKey } from './_shared'

/**
 * Detect drift between the deployed queue configuration and the live
 * OPNsense box. Re-finds each declared queue by description and diffs the
 * managed fields: a missing queue is critical drift; a changed weight or
 * enabled state is a warning.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOpnsenseClient(ctx.component.hostname, ctx.component.port, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractQueueSpecs(ctx.deployedConfig).filter((s) => s.description)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await searchQueues(client)
    const byKey = new Map<string, LiveQueue>(live.filter((q) => q.description).map((q) => [queueKey(q.description as string), q]))

    for (const spec of specs) {
      const found = byKey.get(queueKey(spec.description))

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
      const liveWeight = String(found.weight ?? '100')
      if (liveWeight !== String(spec.weight)) {
        diffs.push({ field: `${spec.description}.weight`, expected: String(spec.weight), actual: liveWeight, severity: 'warning' })
      }
    }
  } catch {
    diffs.push({ field: 'opnsense', expected: 'reachable', actual: 'unreachable', severity: 'critical' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
