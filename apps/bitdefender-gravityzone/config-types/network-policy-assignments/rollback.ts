import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildGravityZoneClient } from '../../lib/gravityZone'
import { assignPolicy } from '../../lib/gravityZoneApi'
import type { PolicyAssignmentRollbackEntry } from './deploy'

/**
 * Roll back policy assignments by resetting every deployed target back to
 * inheriting its parent container's policy (inheritFromAbove: true).
 *
 * KNOWN LIMITATION: this is a best-effort reset, not a restore of each
 * target's literal PRIOR explicit assignment. GravityZone's Public API
 * exposes no confirmed method to read "the current policy assignment for
 * endpoint X" independent of network.getManagedEndpointDetails, whose
 * response schema for policy information this app's research could not
 * verify against a live tenant (see README.md "Known limitations") — so
 * rollback does not guess at a prior policyId it cannot verify.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildGravityZoneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous = (ctx.rollbackData as { previous?: PolicyAssignmentRollbackEntry[] } | undefined)?.previous
  if (!previous || previous.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previous) {
      await assignPolicy(client, { targetIds: entry.targetIds, inheritFromAbove: true, forcePolicyInheritance: false })
      reverted.push(entry.assignmentName)
    }
    return {
      success: true,
      message:
        `Reset ${reverted.length} policy assignment(s) to inherit from their parent container: ${reverted.join(', ')}. ` +
        'This restores default inheritance, not necessarily each target\'s specific prior explicit assignment — see README.md "Known limitations".',
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previous.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
