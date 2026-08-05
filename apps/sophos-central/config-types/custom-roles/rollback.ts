import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSophosClient } from '../../lib/sophosCentral'
import { deleteRole, updateRole } from '../../lib/sophosApi'
import type { CustomRoleRollbackEntry } from './deploy'

/**
 * Roll back custom roles using the state captured during deploy:
 *   - roles that were created are deleted (fails clearly if Sophos returns
 *     409 because the role is still assigned to an admin)
 *   - roles that were updated are restored to their captured prior body
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildSophosClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous = (ctx.rollbackData as { previous?: CustomRoleRollbackEntry[] } | undefined)?.previous
  if (!previous || previous.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previous].reverse()) {
      if (!entry.existed) {
        if (entry.id) await deleteRole(client, entry.id)
      } else if (entry.id && entry.prior) {
        await updateRole(client, entry.id, {
          name: entry.prior.name,
          description: entry.prior.description,
          permissionSets: entry.prior.permissionSets,
        })
      }
      reverted.push(entry.name)
    }
    return { success: true, message: `Rolled back ${reverted.length} custom role(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previous.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
