import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import { addRoles, revokeRoles, type RoleMappingRollbackEntry } from './deploy'
import { bindingLabel } from './validate'

/**
 * Roll back MSSP role mappings by reversing the deltas captured during deploy:
 *   - revoke the role ids this deploy granted
 *   - re-grant the role ids this deploy revoked
 * A binding that did not exist before deploy had only grants, so reversing them
 * revokes every added role — leaving the binding with no roles (i.e. removed).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: RoleMappingRollbackEntry[] })
    ?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      await revokeRoles(client, entry.userGroupId, entry.cidGroupId, entry.added ?? [])
      await addRoles(client, entry.userGroupId, entry.cidGroupId, entry.revoked ?? [])
      reverted.push(bindingLabel(entry.userGroupId, entry.cidGroupId))
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} MSSP role mapping(s): ${reverted.join('; ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} mapping(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
