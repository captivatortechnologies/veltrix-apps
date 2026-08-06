import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildGravityZoneClient } from '../../lib/gravityZone'
import { deleteCustomGroup } from '../../lib/gravityZoneApi'
import type { NetworkGroupRollbackEntry } from './deploy'

/**
 * Roll back network groups using the state captured during deploy: groups
 * this deploy CREATED are deleted (network.deleteCustomGroup); groups that
 * already existed are left alone. Deleting a non-empty group requires the
 * item's "Force delete when rolled back" flag — otherwise the rollback for
 * that group fails rather than silently forcing a destructive delete.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildGravityZoneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous = (ctx.rollbackData as { previous?: NetworkGroupRollbackEntry[] } | undefined)?.previous
  if (!previous || previous.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  const skipped: string[] = []

  try {
    for (const entry of [...previous].reverse()) {
      if (entry.action === 'created' && entry.newId) {
        await deleteCustomGroup(client, entry.newId, entry.force)
        reverted.push(entry.groupName)
      } else {
        skipped.push(entry.groupName)
      }
    }
    const message =
      `Rolled back ${reverted.length} network group(s)${reverted.length ? `: ${reverted.join(', ')}` : ''}` +
      (skipped.length ? `. Left unchanged (already existed before this deploy): ${skipped.join(', ')}.` : '.')
    return { success: true, message }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previous.filter((p) => p.action === 'created').length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
