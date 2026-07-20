import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage } from '../../lib/okta'
import { listRolePermissions, reconcilePermissions, type RoleRollbackEntry } from './deploy'

/**
 * Roll back custom admin roles using the state captured during deploy:
 *   - roles this deploy CREATED are deleted. Okta may refuse a delete while the
 *     role is still bound to a principal via a resource-set binding — that error
 *     is surfaced clearly so the operator can remove the binding first.
 *   - roles this deploy UPDATED are PUT back to their captured prior
 *     label/description, and their permission set is reconciled back to the
 *     captured prior permissions via the /permissions sub-resource.
 *
 * Rollback is keyed on the role id Okta returned, never on the label.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
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
    // Undo in reverse so later changes are reverted before earlier ones.
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        // Deploy created this role — remove it.
        if (entry.id) {
          const del = await client.request('DELETE', `/iam/roles/${entry.id}`)
          if (!del.ok && del.status !== 404) {
            throw new Error(
              `Failed to delete role "${entry.label}": ${oktaErrorMessage(del)}. Okta may refuse to delete a role that is still bound to a principal — remove its resource-set bindings first, then retry the rollback.`,
            )
          }
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this role — restore prior label/description, then
        // reconcile permissions back to the captured prior set.
        const res = await client.request('PUT', `/iam/roles/${entry.id}`, {
          body: { label: entry.prior.label, description: entry.prior.description },
        })
        if (!res.ok) {
          throw new Error(`Failed to restore role "${entry.label}": ${oktaErrorMessage(res)}`)
        }
        const current = await listRolePermissions(client, entry.id)
        await reconcilePermissions(client, entry.id, entry.priorPermissions ?? [], current)
      }

      reverted.push(entry.label)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} custom admin role(s): ${reverted.join(', ')}.`,
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
