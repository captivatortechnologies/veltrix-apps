import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildS1Client } from '../../lib/s1'
import { listGroups } from './deploy'
import { extractGroupSpecs, type LiveGroup } from './validate'

/**
 * Detect drift between the deployed group configuration and the live site.
 * Re-finds each declared group by name and diffs the annotated fields
 * (description and the inherit-policy flag) as informational drift; a group that
 * has gone missing is critical drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildS1Client(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built
  if (!client.hasScope) return { hasDrift: false, diffs: [] }

  const specs = extractGroupSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listGroups(client)
    const byName = new Map<string, LiveGroup>(live.filter((g) => g.name).map((g) => [g.name as string, g]))

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
      const liveInherits = found.inherits ?? true
      if (liveInherits !== spec.inherits) {
        diffs.push({
          field: `${spec.name}.inherits`,
          expected: String(spec.inherits),
          actual: String(liveInherits),
          severity: 'info',
        })
      }
    }
  } catch (error) {
    diffs.push({
      field: 'sentinelone',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
