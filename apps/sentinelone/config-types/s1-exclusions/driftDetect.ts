import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildS1Client } from '../../lib/s1'
import { attachDriftActor, veltrixActorLogins } from '../../lib/s1ActivityLog'
import { listExclusions } from './deploy'
import { exclusionKey, extractExclusionSpecs, type LiveExclusion } from './validate'

/**
 * Detect drift between the deployed exclusion configuration and the live scope.
 * Re-finds each declared exclusion by its (type, value, osType) key and diffs the
 * managed fields (description and, for path exclusions, mode); a missing
 * exclusion is critical drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildS1Client(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built
  if (!client.hasScope) return { hasDrift: false, diffs: [] }

  const specs = extractExclusionSpecs(ctx.deployedConfig).filter((s) => s.type && s.value && s.osType)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listExclusions(client)
    const byKey = new Map<string, LiveExclusion>(
      live
        .filter((e) => e.type && e.value && e.osType)
        .map((e) => [exclusionKey({ type: e.type as string, value: e.value as string, osType: e.osType as string }), e]),
    )

    const veltrixLogins = veltrixActorLogins(ctx.credential)
    const attributions: Array<Promise<void>> = []

    for (const spec of specs) {
      const label = `${spec.type} ${spec.value}`
      const before = diffs.length
      const found = byKey.get(exclusionKey(spec))
      if (!found) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
      } else {
        const liveDescription = (typeof found.description === 'string' ? found.description : '').trim()
        if ((spec.description ?? '') !== liveDescription) {
          diffs.push({ field: `${label}.description`, expected: spec.description ?? 'not set', actual: liveDescription || 'not set', severity: 'info' })
        }
        if (spec.type === 'path' && (found.mode ?? '') !== spec.mode) {
          diffs.push({ field: `${label}.mode`, expected: spec.mode, actual: found.mode ?? 'not set', severity: 'warning' })
        }
      }

      // Best-effort "who changed it + when" for this exclusion's drift only.
      const objectDiffs = diffs.slice(before)
      if (objectDiffs.length > 0) {
        attributions.push(
          attachDriftActor(client, objectDiffs, {
            targetId: found?.id,
            targetName: spec.value,
            excludeActorLogins: veltrixLogins,
          }),
        )
      }
    }
    await Promise.all(attributions)
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
