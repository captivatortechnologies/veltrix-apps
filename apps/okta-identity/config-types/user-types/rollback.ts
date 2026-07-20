import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage } from '../../lib/okta'
import { buildUserTypeBody, getUserTypeById, type UserTypeRollbackEntry } from './deploy'

/**
 * Roll back user types using the state captured during deploy:
 *   - types this deploy CREATED are deleted. Okta REFUSES to delete the default
 *     user type or a type that is currently assigned to users — a created type is
 *     never the default (guarded defensively), and the assignment error is
 *     surfaced clearly so the operator can reassign those users first.
 *   - types this deploy UPDATED are PUT back to their captured prior definition
 *     (displayName / description; name is immutable and unchanged).
 *
 * Rollback is keyed on the user-type id Okta returned, never on the name. There
 * is no lifecycle to restore.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: UserTypeRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  const skipped: string[] = []

  try {
    // Undo in reverse so later changes are reverted before earlier ones.
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        // Deploy created this type — remove it. Refuse to delete a live default
        // type (defensive; a created type is never the default).
        if (entry.id) {
          const live = await getUserTypeById(client, entry.id)
          if (live?.default === true) {
            skipped.push(`${entry.name} (default user type — not deleted)`)
            continue
          }
          const del = await client.request('DELETE', `/meta/types/user/${entry.id}`)
          if (!del.ok && del.status !== 404) {
            throw new Error(
              `Failed to delete user type "${entry.name}": ${oktaErrorMessage(del)}. Okta will not delete a user type that is still assigned to users — reassign those users to another type first, then retry the rollback.`,
            )
          }
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this type — restore its captured prior definition.
        const res = await client.request('PUT', `/meta/types/user/${entry.id}`, {
          body: buildUserTypeBody({
            sectionName: entry.name,
            name: entry.prior.name,
            displayName: entry.prior.displayName,
            description: entry.prior.description || undefined,
          }),
        })
        if (!res.ok) {
          throw new Error(`Failed to restore user type "${entry.name}": ${oktaErrorMessage(res)}`)
        }
      }

      reverted.push(entry.name)
    }

    const skipNote = skipped.length ? ` Skipped: ${skipped.join(', ')}.` : ''
    return {
      success: true,
      message: `Rolled back ${reverted.length} user type(s): ${reverted.join(', ')}.${skipNote}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} type(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
