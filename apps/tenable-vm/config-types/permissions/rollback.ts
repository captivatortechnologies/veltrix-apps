import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildTenableClient, tenableErrorMessage } from '../../lib/tenable'
import type { PermissionRollbackEntry } from './deploy'

/**
 * Roll back permissions using the state captured during deploy:
 *   - permissions that were created are deleted (DELETE /.../permissions/{uuid})
 *   - permissions that were updated are restored (PUT) to their prior body
 *
 * Rollback keys on the stable permission_uuid, never the name, so a deploy that
 * renamed a permission can still be reverted. SENSITIVE RBAC: restoring a prior
 * body re-grants exactly the access that existed before the deploy.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: PermissionRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      const label = entry.name

      if (!entry.existed) {
        // Deploy created this permission — remove it. 404 means it is already
        // gone (or was never created), which is the desired end state.
        if (entry.uuid) {
          const res = await client.request('DELETE', `/api/v3/access-control/permissions/${entry.uuid}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete permission "${label}": ${tenableErrorMessage(res)}`)
          }
        }
      } else if (entry.uuid && entry.prior) {
        // Deploy updated this permission — restore the captured prior body.
        const restore: Record<string, unknown> = {}
        if (entry.prior.name !== undefined) restore.name = entry.prior.name
        if (entry.prior.actions !== undefined) restore.actions = entry.prior.actions
        if (entry.prior.objects !== undefined) restore.objects = entry.prior.objects
        if (entry.prior.subjects !== undefined) restore.subjects = entry.prior.subjects

        const res = await client.request(
          'PUT',
          `/api/v3/access-control/permissions/${entry.uuid}`,
          { body: restore },
        )
        if (!res.ok) {
          throw new Error(`Failed to restore permission "${label}": ${tenableErrorMessage(res)}`)
        }
      }

      reverted.push(label)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} permission(s): ${reverted.join(', ')}. Note: rolling back an access permission changes who can act on the affected assets.`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} permission(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
