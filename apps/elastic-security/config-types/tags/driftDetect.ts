import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient } from '../../lib/elastic'
import { getTag } from './deploy'
import { extractTagSpecs } from './validate'

/**
 * Detect drift between the deployed tag configuration and the live Kibana
 * state. Re-fetches each declared tag by its (immutable) id and diffs name /
 * color / description.
 *
 * The Kibana Tags API's tag attributes (name/color/description) carry no
 * modifier field and no per-object audit trail, so drift here is reported
 * without an actor ("—") — unattributed by design, consistent with spaces /
 * ILM / role-mappings, rather than fabricating one.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildElasticClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractTagSpecs(ctx.deployedConfig).filter((s) => s.id && s.name && s.color)

  for (const spec of specs) {
    try {
      const live = await getTag(client, spec.id)

      if (!live) {
        diffs.push({ field: spec.id, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const liveName = typeof live.name === 'string' ? live.name : ''
      if (spec.name !== liveName) {
        diffs.push({ field: `${spec.id}.name`, expected: spec.name, actual: liveName || 'not set', severity: 'warning' })
      }

      const liveColor = typeof live.color === 'string' ? live.color : ''
      if (spec.color.toLowerCase() !== liveColor.toLowerCase()) {
        diffs.push({ field: `${spec.id}.color`, expected: spec.color, actual: liveColor || 'not set', severity: 'info' })
      }

      const liveDescription = typeof live.description === 'string' ? live.description : ''
      if ((spec.description ?? '') !== liveDescription) {
        diffs.push({
          field: `${spec.id}.description`,
          expected: spec.description ?? 'not set',
          actual: liveDescription || 'not set',
          severity: 'info',
        })
      }
    } catch (error) {
      diffs.push({
        field: spec.id,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
