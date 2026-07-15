import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildTenableClient, tenableErrorMessage } from '../../lib/tenable'
import type { RoleRollbackEntry } from './deploy'

/**
 * Roll back roles using the state captured during deploy:
 *   - roles that were created are deleted (DELETE /access-control/v1/roles/{uuid})
 *   - roles that were updated are restored (PUT) to their prior body
 *
 * Rollback is keyed on the stable uuid, never the name. Only CUSTOM roles ever
 * reach this state — deploy refuses SYSTEM roles before any write — so a
 * built-in role is never deleted or restored here. Deleting a role that is
 * still assigned to users removes their access via that role.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: RoleRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this role — remove it. 404 means it is already gone
        // (or was never created), which is the desired end state.
        if (entry.uuid) {
          const res = await client.request('DELETE', `/access-control/v1/roles/${entry.uuid}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete role "${entry.name}": ${tenableErrorMessage(res)}`)
          }
        }
      } else if (entry.uuid && entry.prior) {
        // Deploy updated this role — restore the captured prior body.
        const restore: Record<string, unknown> = {}
        if (entry.prior.name !== undefined) restore.name = entry.prior.name
        if (entry.prior.description !== undefined) restore.description = entry.prior.description
        if (entry.prior.role_permission_strings !== undefined) {
          restore.role_permission_strings = entry.prior.role_permission_strings
        }

        const res = await client.request('PUT', `/access-control/v1/roles/${entry.uuid}`, { body: restore })
        if (!res.ok) {
          throw new Error(`Failed to restore role "${entry.name}": ${tenableErrorMessage(res)}`)
        }
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} role(s): ${reverted.join(', ')}. Note: deleting a role removes the access it granted to any users still assigned to it.`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} role(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
