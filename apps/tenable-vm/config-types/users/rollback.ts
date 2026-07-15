import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildTenableClient, tenableErrorMessage } from '../../lib/tenable'
import type { UserRollbackEntry } from './deploy'

/**
 * Roll back users using the state captured during deploy:
 *   - users this deploy created are deleted (DELETE /users/{id})
 *   - users this deploy updated are PUT back to their captured prior NON-SECRET
 *     body, and their prior enabled state is restored via PUT /users/{id}/enabled
 *
 * The password is NEVER rolled back: Tenable never returns it, so a prior
 * password cannot be captured or restored. A rolled-back update therefore keeps
 * whatever password the deploy set (if it changed one) — only the non-secret
 * fields and the enabled state are reverted.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: UserRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this user — remove it. 404 means it was never created
        // (or already removed), which is the desired end state.
        if (entry.id !== undefined) {
          const res = await client.request('DELETE', `/users/${entry.id}`)
          if (!res.ok && res.status !== 404) {
            throw new Error(`Failed to delete user "${entry.username}": ${tenableErrorMessage(res)}`)
          }
        }
      } else if (entry.id !== undefined && entry.prior) {
        // Deploy updated this user — restore the captured prior non-secret body.
        const restore: Record<string, unknown> = {}
        if (entry.prior.permissions !== undefined) restore.permissions = entry.prior.permissions
        if (entry.prior.name !== undefined) restore.name = entry.prior.name
        if (entry.prior.email !== undefined) restore.email = entry.prior.email
        if (Object.keys(restore).length > 0) {
          const res = await client.request('PUT', `/users/${entry.id}`, { body: restore })
          if (!res.ok) {
            throw new Error(`Failed to restore user "${entry.username}": ${tenableErrorMessage(res)}`)
          }
        }

        // Restore the prior enabled state through its own endpoint.
        if (entry.prior.enabled !== undefined) {
          const res = await client.request('PUT', `/users/${entry.id}/enabled`, {
            body: { enabled: entry.prior.enabled },
          })
          if (!res.ok) {
            throw new Error(
              `Failed to restore enabled state for user "${entry.username}": ${tenableErrorMessage(res)}`,
            )
          }
        }
      }

      reverted.push(entry.username)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} user(s): ${reverted.join(', ')}. Note: passwords are not restored — Tenable never returns them.`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} user(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
