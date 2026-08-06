import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOnePasswordClient, buildPatchOp, scimErrorMessage } from '../../lib/onePassword'
import type { UserRollbackEntry } from './deploy'

/**
 * Roll back users using the state captured during deploy:
 *   - users this deploy CREATED are SUSPENDED (PATCH active:false) - the
 *     bridge has no confirmed DELETE, so this is the closest reversible
 *     action; the account itself is left for an operator to remove
 *     permanently in the 1Password web console if that's truly intended.
 *   - users this deploy UPDATED have their prior active/name state restored
 *     exactly (PATCH active + name.givenName + name.familyName back to what
 *     was live before deploy ran).
 *
 * Never touches a user this deploy did not create or change.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildOnePasswordClient(ctx.component.hostname, ctx.credential, ctx.settings)
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
      if (!entry.id) {
        reverted.push(entry.userName)
        continue
      }

      if (!entry.existed) {
        const res = await client.request('PATCH', `/Users/${encodeURIComponent(entry.id)}`, {
          body: buildPatchOp([{ op: 'replace', path: 'active', value: false }]),
        })
        if (!res.ok) {
          throw new Error(`Failed to suspend created user "${entry.userName}": ${scimErrorMessage(res)}`)
        }
      } else if (entry.prior) {
        const res = await client.request('PATCH', `/Users/${encodeURIComponent(entry.id)}`, {
          body: buildPatchOp([
            { op: 'replace', path: 'active', value: entry.prior.active },
            { op: 'replace', path: 'name.givenName', value: entry.prior.givenName },
            { op: 'replace', path: 'name.familyName', value: entry.prior.familyName },
          ]),
        })
        if (!res.ok) {
          throw new Error(`Failed to restore user "${entry.userName}": ${scimErrorMessage(res)}`)
        }
      }

      reverted.push(entry.userName)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} user(s): ${reverted.join(', ')}. Users created by the deploy were suspended, not deleted (see README.md Coverage).`,
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
