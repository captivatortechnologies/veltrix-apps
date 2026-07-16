import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildInsightVMClient } from '../../lib/insightvm'
import { listTags } from './deploy'
import { extractTagSpecs, tagKey, type LiveTag } from './validate'

/**
 * Detect drift between the deployed tag configuration and the live console.
 * Re-finds each declared tag by its (name, type) key and diffs the managed
 * fields (color, riskModifier); a missing tag is critical drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildInsightVMClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractTagSpecs(ctx.deployedConfig).filter((s) => s.name && s.type)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listTags(client)
    const byKey = new Map<string, LiveTag>(
      live.filter((t) => t.name && t.type).map((t) => [tagKey({ name: t.name as string, type: t.type as string }), t]),
    )

    for (const spec of specs) {
      const found = byKey.get(tagKey(spec))
      if (!found) {
        diffs.push({ field: `${spec.name} (${spec.type})`, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      if (spec.color && (found.color ?? '') !== spec.color) {
        diffs.push({ field: `${spec.name}.color`, expected: spec.color, actual: found.color ?? 'not set', severity: 'info' })
      }
      if (spec.type === 'criticality' && spec.riskModifier !== undefined && found.riskModifier !== spec.riskModifier) {
        diffs.push({ field: `${spec.name}.riskModifier`, expected: String(spec.riskModifier), actual: String(found.riskModifier ?? 'not set'), severity: 'warning' })
      }
    }
  } catch (error) {
    diffs.push({
      field: 'insightvm',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
