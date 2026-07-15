import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage } from '../../lib/okta'
import { getScopeById, type ScopeRollbackEntry } from './deploy'

/**
 * Roll back authorization-server scopes using the state captured during deploy:
 *   - scopes this deploy CREATED are deleted. A live `system: true` scope is
 *     REFUSED (never deleted) — defensive, since a created scope is never
 *     system. A delete tolerates a 404 (already gone is the desired end state).
 *   - scopes this deploy UPDATED are PUT back to their captured prior body.
 *
 * Rollback is keyed on the scope id Okta returned (never the name) and the
 * parent authServerId captured with each entry. There is NO lifecycle for a
 * scope, so no status to restore.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ScopeRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  const skipped: string[] = []

  try {
    // Undo in reverse so later changes are reverted before earlier ones.
    for (const entry of [...previousState].reverse()) {
      const label = `${entry.authServerId}:${entry.name}`

      if (!entry.existed) {
        // Deploy created this scope — remove it. Refuse to delete a live system
        // scope (defensive; a created scope is never system, but never delete a
        // built-in scope).
        if (entry.id) {
          const live = await getScopeById(client, entry.authServerId, entry.id)
          if (live?.system === true) {
            skipped.push(`${label} (system scope — not deleted)`)
            continue
          }
          const res = await client.request(
            'DELETE',
            `/authorizationServers/${entry.authServerId}/scopes/${entry.id}`,
          )
          if (!res.ok && res.status !== 404) {
            throw new Error(`Failed to delete scope "${label}": ${oktaErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this scope — restore its captured prior body.
        const res = await client.request(
          'PUT',
          `/authorizationServers/${entry.authServerId}/scopes/${entry.id}`,
          { body: entry.prior },
        )
        if (!res.ok) {
          throw new Error(`Failed to restore scope "${label}": ${oktaErrorMessage(res)}`)
        }
      }

      reverted.push(label)
    }

    const skipNote = skipped.length ? ` Skipped: ${skipped.join(', ')}.` : ''
    return {
      success: true,
      message: `Rolled back ${reverted.length} authorization-server scope(s): ${reverted.join(', ')}.${skipNote}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} scope(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
