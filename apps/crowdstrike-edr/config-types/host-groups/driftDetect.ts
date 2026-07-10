import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import { findHostGroup } from './deploy'
import { extractHostGroupSpecs } from './validate'

/**
 * Detect drift between the deployed host group configuration and the live
 * tenant state. Looks up each declared group and diffs the managed fields.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractHostGroupSpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    try {
      const live = await findHostGroup(client, spec.name)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      // group_type is immutable — a mismatch means the group was recreated out-of-band
      if (live.group_type && live.group_type !== spec.groupType) {
        diffs.push({
          field: `${spec.name}.groupType`,
          expected: spec.groupType,
          actual: live.group_type,
          severity: 'critical',
        })
      }

      // The assignment rule decides membership, and membership decides which
      // hosts inherit policies/IOCs targeting this group.
      if (spec.groupType === 'dynamic' && spec.assignmentRule) {
        const liveRule = (live.assignment_rule ?? '').trim()
        if (liveRule !== spec.assignmentRule) {
          diffs.push({
            field: `${spec.name}.assignmentRule`,
            expected: spec.assignmentRule,
            actual: liveRule || 'not set',
            severity: 'critical',
          })
        }
      }

      const liveDescription = (live.description ?? '').trim()
      if ((spec.description ?? '') !== liveDescription) {
        diffs.push({
          field: `${spec.name}.description`,
          expected: spec.description ?? 'not set',
          actual: liveDescription || 'not set',
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
